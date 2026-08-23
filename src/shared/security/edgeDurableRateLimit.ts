/** Edge/Proxy-compatible durable limiter. Deliberately avoids node:crypto and
 * shared clients so Proxy can run in its restricted runtime. */

import { resolveSupabaseServerUrl } from "@/shared/lib/supabase/serverUrl";

export type EdgeRateLimitResult = "allowed" | "limited" | "unavailable";

type EdgeBucket = {
  name: string;
  limit: number;
  windowSeconds: number;
};

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function consumeEdgeDurableRateLimits(input: {
  scope: string;
  material: string[];
  buckets: readonly EdgeBucket[];
}): Promise<EdgeRateLimitResult> {
  const url = resolveSupabaseServerUrl()?.replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey || input.material.length === 0) return "unavailable";

  try {
    const persistedBuckets: Array<{
      p_key: string;
      p_limit: number;
      p_window_seconds: number;
    }> = [];
    for (const bucket of input.buckets) {
      if (
        !bucket.name ||
        !Number.isSafeInteger(bucket.limit) ||
        bucket.limit < 1 ||
        !Number.isSafeInteger(bucket.windowSeconds) ||
        bucket.windowSeconds < 1
      ) {
        return "unavailable";
      }
      const digest = await sha256(
        JSON.stringify([input.scope, bucket.name, ...input.material]),
      );
      persistedBuckets.push({
        p_key: `public-edge:${input.scope}:${bucket.name}:${digest}`,
        p_limit: bucket.limit,
        p_window_seconds: bucket.windowSeconds,
      });
    }
    if (persistedBuckets.length === 0) return "unavailable";

    const response = await fetch(`${url}/rest/v1/rpc/rate_limit_hit_many`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_buckets: persistedBuckets }),
      cache: "no-store",
    });
    if (!response.ok) return "unavailable";
    const allowed: unknown = await response.json();
    if (typeof allowed !== "boolean") return "unavailable";
    return allowed ? "allowed" : "limited";
  } catch {
    return "unavailable";
  }
}
