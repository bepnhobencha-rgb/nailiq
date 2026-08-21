const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

export async function readUrlEncodedFormWithLimit(
  request: Request,
  maxBytes: number,
): Promise<URLSearchParams | null> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== FORM_CONTENT_TYPE
  ) {
    return null;
  }
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) return null;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}
