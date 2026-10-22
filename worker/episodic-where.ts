/**
 * /api/episodic/where: streaming links for one show in Turkey, from JustWatch.
 * TVmaze only knows the original network (Modern Family says ABC), so the show
 * page asks here for the local platforms and their show-page URLs.
 * JustWatch has no IMDb lookup, so we search by title and match the IMDb id.
 * Results are cached for a week in the Workers cache.
 */

const JW = "https://apis.justwatch.com/graphql";
const TTL_S = 7 * 24 * 3600;
const QUERY = `query($c:Country!,$l:Language!,$q:String!){popularTitles(country:$c,first:8,filter:{searchQuery:$q,objectTypes:[SHOW]}){edges{node{content(country:$c,language:$l){title externalIds{imdbId}} offers(country:$c,platform:WEB){monetizationType standardWebURL package{clearName technicalName}}}}}}`;

type Offer = { monetizationType: string; standardWebURL: string; package: { clearName: string; technicalName: string } };
type Node = { content: { title: string; externalIds: { imdbId: string | null } }; offers: Offer[] };
export type Where = { name: string; key: string; url: string; type: "stream" | "free" | "rent" | "buy" };

const NAMES: Record<string, string> = { disneyplus: "Disney+", max: "HBO Max", amazonprime: "Prime Video", amazon: "Prime Video Store", turkcelltvplus: "TV+", itunes: "Apple TV", appletvplus: "Apple TV+" };
const TYPES: Record<string, Where["type"]> = { FLATRATE: "stream", FREE: "free", ADS: "free", RENT: "rent", BUY: "buy" };

async function lookup(imdb: string, title: string): Promise<Where[]> {
  const r = await fetch(JW, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { c: "TR", l: "tr", q: title } }),
  });
  if (!r.ok) throw new Error("justwatch " + r.status);
  const body = (await r.json()) as { data?: { popularTitles?: { edges?: { node: Node }[] } } };
  const node = body.data?.popularTitles?.edges?.find((e) => e.node.content.externalIds.imdbId === imdb)?.node;
  if (!node) return [];
  const seen = new Set<string>();
  const out: Where[] = [];
  for (const o of node.offers) {
    const type = TYPES[o.monetizationType];
    const key = o.package.technicalName;
    if (!type || !o.standardWebURL || seen.has(key + type)) continue;
    seen.add(key + type);
    out.push({ name: NAMES[key] || o.package.clearName, key, url: o.standardWebURL, type });
  }
  const order = ["stream", "free", "rent", "buy"];
  return out.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
}

export async function handleWhere(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const imdb = url.searchParams.get("imdb") || "";
  const title = (url.searchParams.get("title") || "").slice(0, 120);
  if (!/^tt\d{5,10}$/.test(imdb) || !title.trim()) return Response.json({ error: "params" }, { status: 400 });

  const cacheKey = new Request(`https://episodic.cache/where/${imdb}?t=${encodeURIComponent(title)}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let offers: Where[];
  try { offers = await lookup(imdb, title); }
  catch { return Response.json({ error: "upstream" }, { status: 502 }); }
  const res = Response.json({ offers }, { headers: { "Cache-Control": `public, max-age=${TTL_S}` } });
  await cache.put(cacheKey, res.clone());
  return res;
}
