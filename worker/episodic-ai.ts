/**
 * /api/episodic/ask: series recommendations from Claude Haiku 5.5, grounded in the
 * signed-in user's own diary. The history is read here from KV, never sent by the
 * page, so nobody can ask about someone else's account. The API key stays in the
 * Worker. Paid attempts are reserved through a transactional global quota.
 *
 * Calls go through OpenRouter's Anthropic-compatible endpoint when OPENROUTER_API_KEY
 * is set, otherwise straight to the Claude API with ANTHROPIC_API_KEY.
 */

import { readBody, BodyTooLarge } from "./episodic-body";
import { reserveAsk } from "./episodic-quota";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export interface AskEnv {
  EPISODIC: KVNamespace;
  EPISODIC_QUOTA?: DurableObjectNamespace;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}

function claudeClient(env: AskEnv): { client: Anthropic; model: string } | null {
  if (env.OPENROUTER_API_KEY) {
    return {
      client: new Anthropic({ maxRetries: 0, timeout: 45_000, apiKey: null, authToken: env.OPENROUTER_API_KEY, baseURL: "https://openrouter.ai/api" }),
      model: "anthropic/claude-haiku-5.5",
    };
  }
  if (env.ANTHROPIC_API_KEY) return { client: new Anthropic({ maxRetries: 0, timeout: 45_000, apiKey: env.ANTHROPIC_API_KEY }), model: "claude-haiku-5-5" };
  return null;
}
const MAX_TURNS = 6;
const MAX_TEXT = 2000;

const Answer = z.object({
  reply: z.string(),
  picks: z.array(
    z.object({
      title: z.string(),
      year: z.string(),
      kind: z.enum(["continue", "new", "rewatch"]),
      imdb: z.string(),
      why: z.string(),
    }),
  ),
});
export type AskAnswer = z.infer<typeof Answer>;

const SYSTEM = `You recommend TV series to one person, using their own viewing diary from Episodic, a Letterboxd-style tracker for series. Below come a list of reference shows, then their library.

The reference list holds currently popular, trending and all-time top rated series with genre, real IMDb rating and vote count, size (seasons, episodes, minutes per episode), whether it has ended, which streaming services carry it in Turkey ("TR:"), and a short plot. It is there so you know what is current and have accurate details. It is not a limit: recommend any series you know. Search it for shows that match their taste, and also think beyond it.

How to read it: ratings are 0.5 to 5 stars. "eps 12/40" means 12 of 40 aired episodes watched. "next S2E5" is where they left off. Statuses are watchlist, watching, completed, dropped. Shows with only Netflix progress were imported from Netflix history and may lack ratings.

How to answer:
- Reply in the language the person writes in.
- Draw "new" picks from every series you know, not only the obvious ones: popular and widely discussed shows, acclaimed classics, recent hits, and lesser-known series. Unless they ask for popular or trending shows, include at least one pick that is not in the reference list.
- Judge fit by premise, tone, themes and pacing against the shows they rated highly, finished or liked. In "why", say concretely what the show is about and what connects it to their history, for example which loved show it resembles and how.
- Weigh ratings, likes, reviews and what they finished over what they dropped. Their own ratings show their taste; treat a 2 or 2.5 as a dislike to steer away from.
- Use the show's IMDb rating as a quality signal. For shows in the reference list, copy its IMDb rating into "imdb"; for others, give your best estimate as a number like "8.7", or "" if you do not know it.
- Use the size data when the situation calls for it, and when they name a streaming service, prefer shows the reference list puts on it. Avoid shows rated below about 7.0 unless the personal fit is unusually strong, and then say so.
- Respect the situation they describe. Sick or bored and wanting to binge means easy to follow, many episodes, strong hooks. Short on time means short seasons or limited series.
- Use kind "continue" for a show already in their library they have not finished, with where they left off in "why". Use "new" for shows not in the library. Use "rewatch" only when they ask for comfort or a rewatch.
- Never recommend a "new" show that is already in the library, and do not suggest dropped shows unless asked.
- Give 3 to 6 picks unless they ask for a different number. Use the original release year as a 4-digit string, or "" if unsure. Use the show's best-known English title.
- "reply" is 1 to 3 short sentences that frame the picks. No lists in "reply"; the picks carry the detail.
- If they ask something unrelated to watching series, say briefly that you only help with what to watch, and return no picks.`;

type RefShow = { n: string; y: string; g: string; s: number | null; e: number | null; m: number | null; st: string; imdb: string | null; tvdb: number | null; r: number | null; v: number | null; pl: string[]; p: string | null; o: string };

const normTitle = (t: string) => t.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const votes = (v: number) => (v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? Math.round(v / 1e3) + "k" : String(v));

// Built by scripts/episodic-catalog.mjs and served as a static file; kept per isolate for an hour.
let refCache: { at: number; shows: RefShow[]; text: string } | null = null;
async function loadReference(env: AskEnv): Promise<typeof refCache> {
  if (refCache && Date.now() - refCache.at < 3600_000) return refCache;
  try {
    const r = await env.ASSETS.fetch(new Request("https://assets.local/episodic/catalog/ai-pool.json"));
    if (!r.ok) return refCache;
    const { shows, updated } = (await r.json()) as { shows: RefShow[]; updated: string };
    const lines = shows.map((c) => [
      `${c.n} (${c.y || "?"})`,
      c.g,
      c.r ? `IMDb ${c.r} (${votes(c.v || 0)} votes)` : "",
      [c.s && `${c.s} season${c.s > 1 ? "s" : ""}`, c.e && `${c.e} eps`, c.m && `${c.m} min`, c.st && c.st.toLowerCase()].filter(Boolean).join(", "),
      c.pl.length ? `TR: ${c.pl.join(", ")}` : "",
      c.o,
    ].filter(Boolean).join(" | "));
    refCache = { at: Date.now(), shows, text: `Reference shows (updated ${updated}, ${shows.length} series):\n${lines.join("\n")}` };
  } catch { /* answer without the reference list */ }
  return refCache;
}

type Show = {
  name: string;
  premiered?: string;
  genres?: string[];
  network?: string;
  status?: string | null;
  rating?: number | null;
  liked?: boolean;
  review?: string;
  seasons?: Record<string, { rating?: number | null }>;
  eps?: Record<string, { w?: string | number | null; r?: number | null; c?: string; s?: number; n?: number }>;
  epCount?: { w: number; t: number };
  next?: { s?: number; n?: number; done?: boolean } | null;
  progress?: Record<string, { watched: number; total?: number | null; last?: string }>;
  updatedAt?: string;
};
type Diary = { showId: string; date: string; season?: number | null; rating?: number | null; review?: string; rewatch?: boolean };

/** One line per show the person has touched, most recent first. */
export function buildProfile(data: { shows: Record<string, Show>; diary: Diary[] }, today: string): string {
  const lastSeen: Record<string, string> = {};
  const bump = (id: string, d?: string) => { if (d && (!lastSeen[id] || d > lastSeen[id])) lastSeen[id] = d; };
  for (const d of data.diary) bump(String(d.showId), d.date);

  const rows: { line: string; last: string }[] = [];
  for (const [id, s] of Object.entries(data.shows)) {
    const eps = Object.values(s.eps || {});
    const watched = eps.filter((e) => e.w).length;
    const imported = Object.values(s.progress || {});
    if (!s.status && !s.rating && !s.liked && !watched && !imported.length) continue;
    eps.forEach((e) => typeof e.w === "string" && bump(id, e.w));
    imported.forEach((p) => bump(id, p.last));
    if (!lastSeen[id] && s.updatedAt) bump(id, s.updatedAt.slice(0, 10));

    const parts = [`${s.name} (${s.premiered?.slice(0, 4) || "?"}${s.genres?.length ? ", " + s.genres.slice(0, 3).join("/") : ""})`];
    if (s.status) parts.push(s.status);
    if (s.rating) parts.push(`rated ${s.rating}`);
    if (s.liked) parts.push("liked");
    if (s.epCount) parts.push(`eps ${s.epCount.w}/${s.epCount.t}`);
    else if (imported.length) parts.push(`netflix eps ${imported.reduce((a, p) => a + p.watched, 0)}`);
    if (s.next && !s.next.done && s.next.s && s.status !== "completed" && s.status !== "dropped") parts.push(`next S${s.next.s}E${s.next.n}`);
    const seasonRatings = Object.entries(s.seasons || {}).filter(([, v]) => v.rating).map(([n, v]) => `S${n} ${v.rating}`);
    if (seasonRatings.length) parts.push(`season ratings ${seasonRatings.join(", ")}`);
    const epRatings = eps.map((e) => e.r).filter((r): r is number => !!r);
    if (epRatings.length) parts.push(`episode avg ${(epRatings.reduce((a, b) => a + b, 0) / epRatings.length).toFixed(1)} over ${epRatings.length}`);
    const epNotes = eps.filter((e) => e.c).slice(-3).map((e) => `${e.s ? `S${e.s}E${e.n}` : "ep"}${e.r ? " " + e.r : ""} "${e.c!.replace(/\s+/g, " ").slice(0, 120)}"`);
    if (epNotes.length) parts.push(`episode comments: ${epNotes.join("; ")}`);
    if (lastSeen[id]) parts.push(`last ${lastSeen[id].slice(0, 7)}`);
    if (s.review) parts.push(`review: "${s.review.replace(/\s+/g, " ").slice(0, 240)}"`);
    rows.push({ line: parts.join(" | "), last: lastSeen[id] || "" });
  }
  rows.sort((a, b) => b.last.localeCompare(a.last));

  const names = Object.fromEntries(Object.entries(data.shows).map(([id, s]) => [id, s.name]));
  const recent = [...data.diary].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 25).map((d) =>
    `${d.date} ${names[String(d.showId)] || "?"} ${d.season ? "S" + d.season : "full series"}${d.rating ? " rated " + d.rating : ""}${d.rewatch ? " rewatch" : ""}${d.review ? ` "${d.review.replace(/\s+/g, " ").slice(0, 160)}"` : ""}`);

  return `Today: ${today}\n\nLibrary (${rows.length} shows, most recent first):\n${rows.slice(0, 700).map((r) => r.line).join("\n") || "(empty)"}\n\nRecent diary entries:\n${recent.join("\n") || "(none)"}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function handleAsk(request: Request, env: AskEnv, user: string): Promise<Response> {
  const claude = claudeClient(env);
  if (!claude) return json({ error: "unconfigured" }, 503);

  let turns: { role: "user" | "assistant"; content: string }[];
  try {
    const body = JSON.parse(await readBody(request, 32_000)) as { messages?: unknown };
    if (!Array.isArray(body.messages)) throw 0;
    turns = body.messages.slice(-MAX_TURNS).map((m: { role?: unknown; content?: unknown }) => {
      if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content.trim()) throw 0;
      return { role: m.role, content: m.content.slice(0, MAX_TEXT) };
    });
    while (turns.length && turns[0].role !== "user") turns.shift();
    if (!turns.length || turns[turns.length - 1].role !== "user") throw 0;
  } catch (error) {
    return json({ error: error instanceof BodyTooLarge ? "too_large" : "body" }, error instanceof BodyTooLarge ? 413 : 400);
  }

  const today = new Date().toISOString().slice(0, 10);
  const reservation = await reserveAsk(env.EPISODIC_QUOTA, user);
  if (!reservation.ok) {
    return new Response(reservation.body, { status: reservation.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": reservation.headers.get("Retry-After") || "60" } });
  }
  const { left } = await reservation.json() as { left: number };

  const data = JSON.parse((await env.EPISODIC.get(`d:${user}`)) || '{"shows":{},"diary":[]}');
  const ref = await loadReference(env);
  try {
    const response = await claude.client.messages.parse({
      model: claude.model,
      max_tokens: 4000,
      output_config: { effort: "medium", format: zodOutputFormat(Answer) },
      // The reference list is the same for every account, so it sits in the cached prefix before the profile.
      system: [
        { type: "text", text: SYSTEM },
        ...(ref ? [{ type: "text" as const, text: ref.text.slice(0, 80_000), cache_control: { type: "ephemeral" as const } }] : []),
        { type: "text", text: buildProfile(data, today).slice(0, 40_000), cache_control: { type: "ephemeral" } },
      ],
      messages: turns,
    });
    if (response.stop_reason === "refusal") return json({ error: "refusal" }, 422);
    if (!response.parsed_output) return json({ error: "no_answer" }, 502);
    // Picks that are in the reference list get the real IMDb rating, platforms and poster.
    const picks = response.parsed_output.picks.map((pick) => {
      const same = ref?.shows.filter((c) => normTitle(c.n) === normTitle(pick.title)) || [];
      const c = same.find((x) => x.y === pick.year) || same[0];
      return c ? { ...pick, imdbRating: c.r, platforms: c.pl, poster: c.p, imdbId: c.imdb, tvdb: c.tvdb } : pick;
    });
    return json({ reply: response.parsed_output.reply, picks, left });
  } catch (err) {
    // Failed upstream attempts still consume quota: retries can also incur cost.
    if (err instanceof Anthropic.RateLimitError) return json({ error: "busy" }, 503);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: "unconfigured" }, 503);
    if (err instanceof Anthropic.APIError) return json({ error: "upstream", status: err.status }, 502);
    return json({ error: "upstream" }, 502);
  }
}
