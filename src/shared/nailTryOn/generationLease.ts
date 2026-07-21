export const GENERATION_STALE_MS = 5 * 60 * 1000;

export function isGenerationStale(updatedAt: string, now = Date.now()) {
  const updatedAtMs = Date.parse(updatedAt);
  return Number.isFinite(updatedAtMs) && updatedAtMs <= now - GENERATION_STALE_MS;
}
