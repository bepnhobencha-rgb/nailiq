export const NAIL_TRYON_QUALITY_TIMEOUT_MS = 45_000;
export const NAIL_TRYON_MAPPING_TIMEOUT_MS = 45_000;
export const NAIL_TRYON_GENERATION_TIMEOUT_MS = 180_000;

// Browser deadlines include a small allowance for upload/download and route
// bookkeeping beyond the provider deadline. They remain below Vercel's 300 s
// function ceiling, so the UI always recovers before the platform hard-stops.
export const NAIL_TRYON_UPLOAD_CLIENT_TIMEOUT_MS = 60_000;
export const NAIL_TRYON_CATALOG_CLIENT_TIMEOUT_MS = 15_000;
export const NAIL_TRYON_GENERATION_CLIENT_TIMEOUT_MS = 210_000;

export class NailTryOnRequestTimeoutError extends Error {
  constructor() {
    super("nail_tryon_request_timeout");
    this.name = "NailTryOnRequestTimeoutError";
  }
}

/** Browser fetch with an explicit deadline and guaranteed timer cleanup. */
export async function fetchNailTryOn(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new NailTryOnRequestTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
