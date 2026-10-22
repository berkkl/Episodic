import { readBody } from "./episodic-body";

/**
 * Friends for /episodic: mutual requests, profiles, a feed, and friends on a show page.
 * f:<user> holds { friends, in, out }. Both sides are written on every change.
 * A friend's diary leaves the Worker only through publicView: shows marked
 * private, private diary entries, Ask chats and bare watch records stay home.
 */

type Rec = { w?: string | number | null; r?: number | null; c?: string; d?: string; s?: number; n?: number; t?: string };
type Show = Record<string, unknown> & { name?: string; private?: boolean; eps?: Record<string, Rec>; rating?: number | null; review?: string; ratedAt?: string };
type Entry = Record<string, unknown> & { showId: string; date: string; private?: boolean };
type Doc = { shows: Record<string, Show>; diary: Entry[] };
type Links = { friends: string[]; in: string[]; out: string[] };

const USERNAME = /^[a-z0-9_]{3,20}$/;
const MAX_LINKS = 100;
const SHOW_FIELDS = ["id", "name", "image", "premiered", "ended", "network", "genres", "status", "rating", "liked", "review", "seasons", "epCount", "next", "updatedAt", "ratedAt"];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

async function links(kv: KVNamespace, user: string): Promise<Links> {
  const raw = await kv.get(`f:${user}`);
  const l = raw ? (JSON.parse(raw) as Partial<Links>) : {};
  return { friends: l.friends || [], in: l.in || [], out: l.out || [] };
}
const putLinks = (kv: KVNamespace, user: string, l: Links) => kv.put(`f:${user}`, JSON.stringify(l));
const drop = (a: string[], x: string) => a.filter((y) => y !== x);
const add = (a: string[], x: string) => (a.includes(x) ? a : [...a, x].slice(-MAX_LINKS));

async function doc(kv: KVNamespace, user: string): Promise<Doc> {
  const raw = await kv.get(`d:${user}`);
  const d = raw ? (JSON.parse(raw) as Partial<Doc>) : {};
  return { shows: d.shows || {}, diary: d.diary || [] };
}

/** What a friend may see of a diary. */
export function publicView(d: Doc): Doc {
  const shows: Record<string, Show> = {};
  for (const [id, s] of Object.entries(d.shows)) {
    if (s.private) continue;
    const out: Show = {};
    for (const k of SHOW_FIELDS) if (s[k] !== undefined && s[k] !== null && s[k] !== "") out[k] = s[k];
    const eps: Record<string, Rec> = {};
    for (const [eid, r] of Object.entries(s.eps || {})) {
      if (!r.r && !r.c) continue;
      eps[eid] = { r: r.r || null, c: r.c, s: r.s, n: r.n, t: r.t, d: typeof r.w === "string" ? r.w : r.d };
    }
    if (Object.keys(eps).length) out.eps = eps;
    shows[id] = out;
  }
  const diary = d.diary
    .filter((e) => !e.private && shows[String(e.showId)])
    .map(({ id, showId, date, season, rating, review, rewatch }) => ({ id, showId: String(showId), date, season, rating, review, rewatch }) as Entry);
  return { shows, diary };
}

type Event = { user: string; date: string; showId: string; kind: "log" | "ep" | "rate"; season?: unknown; ep?: Rec; rating?: unknown; review?: unknown; rewatch?: unknown; liked?: unknown };

function events(user: string, d: Doc, today: string): Event[] {
  const out: Event[] = [];
  for (const e of d.diary) out.push({ user, kind: "log", date: e.date, showId: e.showId, season: e.season, rating: e.rating, review: e.review, rewatch: e.rewatch });
  for (const [id, s] of Object.entries(d.shows)) {
    for (const r of Object.values(s.eps || {})) if (r.d) out.push({ user, kind: "ep", date: r.d, showId: id, ep: r, rating: r.r, review: r.c });
    if (s.ratedAt && (s.rating || s.review)) out.push({ user, kind: "rate", date: s.ratedAt.slice(0, 10), showId: id, rating: s.rating, review: s.review, liked: s.liked });
  }
  return out.filter((e) => e.date && e.date <= today);
}

/** The show cards the client needs to draw a list of events: id -> {name, image}. */
function showRefs(docs: Doc[], evs: Event[]) {
  const refs: Record<string, { name?: unknown; image?: unknown }> = {};
  for (const e of evs) for (const d of docs) { const s = d.shows[e.showId]; if (s) { refs[e.showId] = { name: s.name, image: s.image }; break; } }
  return refs;
}

export async function handleFriends(request: Request, kv: KVNamespace, me: string, path: string): Promise<Response> {
  const url = new URL(request.url);

  if (path === "/api/episodic/friends") {
    if (request.method === "GET") return json(await links(kv, me));
    if (request.method !== "POST") return json({ error: "method" }, 405);
    let action = "", them = "";
    try {
      const b = JSON.parse(await readBody(request, 8_192)) as Record<string, unknown>;
      action = String(b.action || "");
      them = String(b.user || "").trim().toLowerCase();
    } catch { return json({ error: "body" }, 400); }
    if (!USERNAME.test(them) || them === me) return json({ error: "user" }, 400);

    const [mine, theirs] = await Promise.all([links(kv, me), links(kv, them)]);
    if (action === "request") {
      if (mine.friends.includes(them)) return json({ ok: true, state: "friends" });
      if (!(await kv.get(`u:${them}`))) return json({ error: "no_user" }, 404);
      if (mine.in.includes(them)) action = "accept"; // they asked first
      else {
        mine.out = add(mine.out, them); theirs.in = add(theirs.in, me);
        await Promise.all([putLinks(kv, me, mine), putLinks(kv, them, theirs)]);
        return json({ ok: true, state: "sent" });
      }
    }
    if (action === "accept") {
      if (!mine.in.includes(them)) return json({ error: "no_request" }, 409);
      mine.in = drop(mine.in, them); theirs.out = drop(theirs.out, me);
      mine.friends = add(mine.friends, them); theirs.friends = add(theirs.friends, me);
    } else if (action === "decline" || action === "cancel" || action === "remove") {
      mine.in = drop(mine.in, them); mine.out = drop(mine.out, them); mine.friends = drop(mine.friends, them);
      theirs.in = drop(theirs.in, me); theirs.out = drop(theirs.out, me); theirs.friends = drop(theirs.friends, me);
    } else return json({ error: "action" }, 400);
    await Promise.all([putLinks(kv, me, mine), putLinks(kv, them, theirs)]);
    return json({ ok: true, state: action === "accept" ? "friends" : "none" });
  }

  if (request.method !== "GET") return json({ error: "method" }, 405);
  const mine = await links(kv, me);

  if (path === "/api/episodic/profile") {
    const u = (url.searchParams.get("u") || "").toLowerCase();
    if (u !== me && !mine.friends.includes(u)) return json({ error: "not_friends" }, 403);
    return json({ user: u, friends: u === me ? mine.friends.length : (await links(kv, u)).friends.length, data: publicView(await doc(kv, u)) });
  }

  if (path === "/api/episodic/feed") {
    const today = new Date().toISOString().slice(0, 10);
    const docs = await Promise.all(mine.friends.map(async (f) => publicView(await doc(kv, f))));
    const evs = docs.flatMap((d, i) => events(mine.friends[i], d, today))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 80);
    return json({ events: evs, shows: showRefs(docs, evs) });
  }

  if (path === "/api/episodic/showfriends") {
    const id = url.searchParams.get("id") || "";
    const docs = await Promise.all(mine.friends.map(async (f) => publicView(await doc(kv, f))));
    const out = docs.flatMap((d, i) => d.shows[id] ? [{ user: mine.friends[i], show: d.shows[id], diary: d.diary.filter((e) => e.showId === id) }] : []);
    return json({ friends: out });
  }

  return json({ error: "not_found" }, 404);
}
