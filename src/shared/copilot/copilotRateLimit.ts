// Per-process sliding-window rate limit for the admin copilot. Works within a
// single serverless instance — across cold starts the counter resets, so this
// is best-effort. Goal: stop a runaway client from draining AI credits, not
// enterprise DDoS protection. Kept self-contained (no Vercel WAF rule needed)
// so Coco is rate-limited the moment it ships.

type Bucket = { hits: number[]; lastSeenAt: number };
const buckets = new Map<string, Bucket>();
const SWEEP_EVERY_MS = 5 * 60 * 1000;
let lastSweep = Date.now();

function sweep(now: number) {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  buckets.forEach((w, k) => {
    if (now - w.lastSeenAt > 60 * 60 * 1000) buckets.delete(k);
  });
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSec: number };

export function copilotRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  sweep(now);
  const cutoff = now - windowMs;
  const w = buckets.get(key) ?? { hits: [], lastSeenAt: now };
  w.hits = w.hits.filter((t) => t > cutoff);
  if (w.hits.length >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((w.hits[0] - cutoff) / 1000));
    w.lastSeenAt = now;
    buckets.set(key, w);
    return { ok: false, retryAfterSec };
  }
  w.hits.push(now);
  w.lastSeenAt = now;
  buckets.set(key, w);
  return { ok: true };
}
