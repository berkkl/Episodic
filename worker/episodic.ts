/**
 * /episodic: invite-only series diary. The page shell in
 * public/episodic/ is static and carries no data. Each account's diary is one
 * JSON document in KV under d:<username>.
 *
 * Accounts: username + password (PBKDF2), sign-up gated by an invite code.
 * Session: HMAC-signed cookie "<username>.<exp>.<sig>".
 */

import { readBody, BodyTooLarge } from "./episodic-body";
import { handleAsk, type AskEnv } from "./episodic-ai";
import { handleWhere } from "./episodic-where";
import { handleFriends } from "./episodic-friends";

export interface EpisodicEnv extends AskEnv {
  EPISODIC: KVNamespace;
  EPISODIC_SECRET?: string;
  EPISODIC_INVITE?: string;
}

type Account = { salt: string; hash: string; iter: number; created: string };

const COOKIE = "episodic";
const SESSION_DAYS = 90;
const AUTH_LIMIT = 10;
const AUTH_WINDOW_S = 3600;
const PBKDF2_ITER = 100_000; // Workers' PBKDF2 ceiling
const MAX_BYTES = 5_000_000;
const USERNAME = /^[a-z0-9_]{3,20}$/;
const EMPTY = '{"shows":{},"diary":[]}';

function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(typeof data === "string" ? data : JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

function sameSiteOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

const hex = (buf: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmacHex(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

async function pbkdf2(password: string, saltHex: string, iter: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}

function timingEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Returns the signed-in username, or null. */
async function sessionUser(request: Request, env: EpisodicEnv): Promise<string | null> {
  if (!env.EPISODIC_SECRET) return null;
  const m = readCookie(request, COOKIE)?.match(/^([a-z0-9_]{3,20})\.(\d{10,16})\.([a-f0-9]{64})$/);
  if (!m || Number(m[2]) < Date.now()) return null;
  const ok = timingEq(m[3], await hmacHex(env.EPISODIC_SECRET, `s.${m[1]}.${m[2]}`));
  return ok ? m[1] : null;
}

async function sessionCookie(env: EpisodicEnv, user: string): Promise<string> {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const sig = await hmacHex(env.EPISODIC_SECRET!, `s.${user}.${exp}`);
  return `${COOKIE}=${user}.${exp}.${sig}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Strict`;
}

async function rateLimited(request: Request, env: EpisodicEnv): Promise<boolean> {
  const key = `rl:${request.headers.get("CF-Connecting-IP") || "0.0.0.0"}`;
  const tries = Number((await env.EPISODIC.get(key)) || 0);
  if (tries >= AUTH_LIMIT) return true;
  await env.EPISODIC.put(key, String(tries + 1), { expirationTtl: AUTH_WINDOW_S });
  return false;
}

async function readCreds(request: Request): Promise<{ user: string; pass: string; invite: string } | null> {
  try {
    const b = JSON.parse(await readBody(request, 8_192)) as Record<string, unknown>;
    const s = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
    return { user: s(b.user, 40).trim().toLowerCase(), pass: s(b.pass, 200), invite: s(b.invite, 200).trim() };
  } catch {
    return null;
  }
}

async function handleAuth(request: Request, env: EpisodicEnv, signup: boolean): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method" }, 405);
  if (!sameSiteOrigin(request)) return json({ error: "origin" }, 403);
  if (!env.EPISODIC_SECRET || (signup && !env.EPISODIC_INVITE)) return json({ error: "unconfigured" }, 503);
  if (await rateLimited(request, env)) return json({ error: "rate" }, 429);

  const c = await readCreds(request);
  if (!c) return json({ error: "body" }, 400);

  if (signup) {
    if (!timingEq(await hmacHex(env.EPISODIC_SECRET, c.invite), await hmacHex(env.EPISODIC_SECRET, env.EPISODIC_INVITE!))) {
      return json({ error: "invite" }, 403);
    }
    if (!USERNAME.test(c.user)) return json({ error: "username" }, 400);
    if (c.pass.length < 8) return json({ error: "password" }, 400);
    if (await env.EPISODIC.get(`u:${c.user}`)) return json({ error: "taken" }, 409);
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    const acct: Account = { salt, hash: await pbkdf2(c.pass, salt, PBKDF2_ITER), iter: PBKDF2_ITER, created: new Date().toISOString() };
    await env.EPISODIC.put(`u:${c.user}`, JSON.stringify(acct));
  } else {
    const raw = USERNAME.test(c.user) ? await env.EPISODIC.get(`u:${c.user}`) : null;
    const acct = raw ? (JSON.parse(raw) as Account) : null;
    // Hash even for unknown users so response time does not reveal which usernames exist.
    const got = await pbkdf2(c.pass, acct?.salt || "00".repeat(16), acct?.iter || PBKDF2_ITER);
    if (!acct || !timingEq(got, acct.hash)) return json({ error: "login" }, 401);
  }
  return json({ ok: true, user: c.user }, 200, { "Set-Cookie": await sessionCookie(env, c.user) });
}

async function handleData(request: Request, env: EpisodicEnv): Promise<Response> {
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "auth" }, 401);
  const key = `d:${user}`;

  if (request.method === "GET") {
    const data = (await env.EPISODIC.get(key)) || EMPTY;
    return json(`{"user":${JSON.stringify(user)},"data":${data}}`);
  }
  if (request.method !== "PUT") return json({ error: "method" }, 405);
  if (!sameSiteOrigin(request)) return json({ error: "origin" }, 403);

  let body: string;
  try { body = await readBody(request, MAX_BYTES); }
  catch (error) { return json({ error: error instanceof BodyTooLarge ? "too_large" : "body" }, error instanceof BodyTooLarge ? 413 : 400); }
  try {
    const obj = JSON.parse(body) as { shows?: unknown; diary?: unknown };
    if (!obj || !obj.shows || typeof obj.shows !== "object" || Array.isArray(obj.shows) || !Array.isArray(obj.diary)) throw 0;
  } catch {
    return json({ error: "invalid" }, 400);
  }
  const prev = await env.EPISODIC.get(key);
  if (prev) await env.EPISODIC.put(`${key}:prev`, prev);
  await env.EPISODIC.put(key, body);
  return json({ ok: true });
}

export async function handleEpisodic(request: Request, env: EpisodicEnv, path: string): Promise<Response> {
  if (path === "/api/episodic/login") return handleAuth(request, env, false);
  if (path === "/api/episodic/signup") return handleAuth(request, env, true);
  if (path === "/api/episodic/logout") {
    return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
  }
  if (path === "/api/episodic/data") return handleData(request, env);
  if (path === "/api/episodic/ask") {
    if (request.method !== "POST") return json({ error: "method" }, 405);
    if (!sameSiteOrigin(request)) return json({ error: "origin" }, 403);
    const user = await sessionUser(request, env);
    if (!user) return json({ error: "auth" }, 401);
    return handleAsk(request, env, user);
  }
  if (path === "/api/episodic/where") {
    if (request.method !== "GET") return json({ error: "method" }, 405);
    if (!(await sessionUser(request, env))) return json({ error: "auth" }, 401);
    return handleWhere(request);
  }
  if (["/api/episodic/friends", "/api/episodic/profile", "/api/episodic/feed", "/api/episodic/showfriends"].includes(path)) {
    if (request.method !== "GET" && !sameSiteOrigin(request)) return json({ error: "origin" }, 403);
    const user = await sessionUser(request, env);
    if (!user) return json({ error: "auth" }, 401);
    return handleFriends(request, env.EPISODIC, user, path);
  }
  return json({ error: "not_found" }, 404);
}
