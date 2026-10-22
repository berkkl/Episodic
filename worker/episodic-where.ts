/** Retained endpoint for older clients; no unofficial provider API is called. */
export async function handleWhere(request: Request): Promise<Response> {
  const title = (new URL(request.url).searchParams.get("title") || "").trim().slice(0, 120);
  if (!title) return Response.json({ error: "params" }, { status: 400 });
  return Response.json({ offers: [], searchUrl: "https://www.justwatch.com/tr/arama?q=" + encodeURIComponent(title) }, { headers: { "Cache-Control": "no-store" } });
}
