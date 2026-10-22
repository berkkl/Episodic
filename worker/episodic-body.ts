/** Bound bytes while streaming, including bodies without Content-Length. */
export class BodyTooLarge extends Error {}
export async function readBody(request: Request, maxBytes: number): Promise<string> {
  const length = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > maxBytes) throw new BodyTooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return result + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new BodyTooLarge(); }
      result += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}
