// Builds public/episodic/catalog/<region>-<platform>.json: every series TMDB lists on a
// streaming platform in one region (availability data comes from JustWatch via TMDB).
// Also builds public/episodic/catalog/popular.json: trending this week plus the most
// popular series per genre (worldwide). The page looks up only the shows a user opens or
// picks on TVmaze, by TVDB or IMDb id.
//
// And public/episodic/catalog/ai-pool.json: reference shows for the Ask tab (popular
// lists, more genre pages, all-time top rated), each with plot, size and regional
// platforms from TMDB. IMDb rating datasets are not downloaded or republished.
// The model sees them as current information, not as the only shows it may suggest.
//
//   npm run episodic:catalog            # Turkey, all platforms, plus popular lists
//   ONLY=popular npm run episodic:catalog
//   REGION=DE npm run episodic:catalog
//
// Needs TMDB_TOKEN in .dev.vars: either the v3 API key or the v4 read access token.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const REGION = process.env.REGION || "TR";
const PLATFORMS = { hbo: 1899, disney: 337, prime: 119, netflix: 8 };
const TOKEN = process.env.TMDB_TOKEN;
if (!TOKEN) throw new Error("TMDB_TOKEN missing. Add it to .dev.vars.");

const v4 = TOKEN.startsWith("eyJ");
async function tmdb(path, params = {}) {
  const url = new URL("https://api.themoviedb.org/3" + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (!v4) url.searchParams.set("api_key", TOKEN);
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(url, { headers: v4 ? { Authorization: `Bearer ${TOKEN}` } : {} });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 2000)); continue; }
    if (!r.ok) throw new Error(`TMDB ${r.status} for ${path}`);
    return r.json();
  }
  throw new Error(`TMDB kept rate limiting ${path}`);
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const dir = resolve(import.meta.dirname, "../public/episodic/catalog");
await mkdir(dir, { recursive: true });
const ids = new Map(); // tmdb id -> external ids, shared across platforms

const slim = (s) => ({
  id: s.id,
  n: s.name,
  o: s.original_name !== s.name ? s.original_name : undefined,
  y: s.first_air_date?.slice(0, 4) || undefined,
  p: s.poster_path || undefined,
  ...ids.get(s.id),
});
async function withIds(shows) {
  await pool(shows.filter((s) => !ids.has(s.id)), 10, async (s) => {
    const x = await tmdb(`/tv/${s.id}/external_ids`).catch(() => ({}));
    ids.set(s.id, { tvdb: x.tvdb_id || null, imdb: x.imdb_id || null });
  });
  const seen = new Set();
  return shows.filter((s) => !seen.has(s.id) && seen.add(s.id)).map(slim);
}

for (const [key, provider] of process.env.ONLY === "popular" ? [] : Object.entries(PLATFORMS)) {
  const params = { watch_region: REGION, with_watch_providers: provider, with_watch_monetization_types: "flatrate|free|ads", sort_by: "popularity.desc" };
  const first = await tmdb("/discover/tv", { ...params, page: 1 });
  // TMDB serves at most 500 pages.
  const pages = Math.min(first.total_pages, 500);
  const rest = await pool(Array.from({ length: pages - 1 }, (_, i) => i + 2), 8, (page) => tmdb("/discover/tv", { ...params, page }));
  const shows = [first, ...rest].flatMap((p) => p.results);

  const list = await withIds(shows);
  const file = `${REGION.toLowerCase()}-${key}.json`;
  await writeFile(resolve(dir, file), JSON.stringify({ region: REGION, platform: key, updated: new Date().toISOString().slice(0, 10), shows: list }));
  console.log(`${file}: ${list.length} series`);
}

// Popular lists. A vote floor keeps barely-rated shows with a popularity spike out.
const GENRES = [
  ["drama", "Drama", 18], ["comedy", "Comedy", 35], ["crime", "Crime", 80], ["mystery", "Mystery", 9648],
  ["scifi", "Sci-Fi & Fantasy", 10765], ["action", "Action & Adventure", 10759], ["animation", "Animation", 16],
  ["documentary", "Documentary", 99], ["war", "War & Politics", 10768], ["reality", "Reality", 10764],
  ["family", "Family", 10751], ["western", "Western", 37],
];
const twoPages = async (path, params) => (await Promise.all([1, 2].map((page) => tmdb(path, { ...params, page })))).flatMap((p) => p.results);
const lists = [{ key: "trending", name: "Trending this week", shows: await withIds(await twoPages("/trending/tv/week", {})) }];
for (const [key, name, genre] of GENRES) {
  const shows = await twoPages("/discover/tv", { with_genres: genre, sort_by: "popularity.desc", "vote_count.gte": 150, without_genres: "10763,10767" });
  lists.push({ key, name, shows: await withIds(shows) });
}
await writeFile(resolve(dir, "popular.json"), JSON.stringify({ updated: new Date().toISOString().slice(0, 10), lists }));
console.log(`popular.json: ${lists.length} lists`);

// ---------- Ask reference shows ----------
const top = (await Promise.all([1, 2, 3, 4, 5].map((page) => tmdb("/discover/tv", {
  sort_by: "vote_average.desc", "vote_count.gte": 1500, without_genres: "10763,10767,10766,10762", page,
})))).flatMap((p) => p.results);
const deeper = (await Promise.all(GENRES.flatMap(([, , genre]) => [3, 4].map((page) =>
  tmdb("/discover/tv", { with_genres: genre, sort_by: "popularity.desc", "vote_count.gte": 300, without_genres: "10763,10767", page }))))).flatMap((p) => p.results);
const poolIds = [...new Set([...lists.flatMap((l) => l.shows.map((s) => s.id)), ...top.map((s) => s.id), ...deeper.map((s) => s.id)])];
const details = (await pool(poolIds, 10, (id) => tmdb(`/tv/${id}`, { append_to_response: "external_ids" }).catch(() => null))).filter(Boolean);

const platformsOf = new Map();
for (const [key, label] of Object.entries({ hbo: "HBO Max", disney: "Disney+", prime: "Prime Video", netflix: "Netflix" })) {
  try {
    const cat = JSON.parse(await readFile(resolve(dir, `${REGION.toLowerCase()}-${key}.json`), "utf8"));
    for (const s of cat.shows) platformsOf.set(s.id, [...(platformsOf.get(s.id) || []), label]);
  } catch { /* platform catalog not built yet */ }
}

const candidates = details.map((d) => {
  return {
    id: d.id,
    n: d.name,
    y: d.first_air_date?.slice(0, 4) || "",
    g: (d.genres || []).map((g) => g.name).join("/"),
    s: d.number_of_seasons || null,
    e: d.number_of_episodes || null,
    m: d.episode_run_time?.[0] || null,
    st: d.status || "",
    imdb: d.external_ids?.imdb_id || null,
    tvdb: d.external_ids?.tvdb_id || null,
    pl: platformsOf.get(d.id) || [],
    p: d.poster_path || null,
    o: (d.overview || "").replace(/\s+/g, " ").slice(0, 240),
  };
});
await writeFile(resolve(dir, "ai-pool.json"), JSON.stringify({ updated: new Date().toISOString().slice(0, 10), region: REGION, shows: candidates }));
console.log(`ai-pool.json: ${candidates.length} reference shows from TMDB`);
