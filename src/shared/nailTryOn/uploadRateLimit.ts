import "server-only";

import { createHash } from "node:crypto";

export const NAIL_TRYON_UPLOAD_RATE_LIMITS = {
  client: { limit: 10, windowSeconds: 60 * 60 },
  salon: { limit: 20, windowSeconds: 60 * 60 },
} as const;

type RateLimitResult = {
  data: unknown;
  error: unknown;
};

type RateLimitHit = (
  key: string,
  limit: number,
  windowSeconds: number,
) => Promise<RateLimitResult>;

function firstForwardedAddress(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim();
  return first || null;
}

/**
 * Returns a non-reversible limiter identifier. Raw client addresses never
 * enter the rate-limit table or logs.
 */
export function nailTryOnClientLimiterId(headers: Headers): string {
  const address = firstForwardedAddress(
    headers.get("x-vercel-forwarded-for"),
  ) ?? firstForwardedAddress(headers.get("x-forwarded-for"))
    ?? headers.get("x-real-ip")?.trim()
    ?? "missing";

  return createHash("sha256").update(address).digest("hex").slice(0, 24);
}

/**
 * Protects both image decoding and the paid quality-check call. The existing
 * 20 uploads/salon/hour ceiling is preserved while adding a client boundary.
 * Limiter outages fail closed instead of exposing unbounded provider spend.
 */
export async function checkNailTryOnUploadRateLimit(
  hit: RateLimitHit,
  input: { salonId: string; clientId: string },
): Promise<"allowed" | "limited" | "unavailable"> {
  const checks = [
    {
      key: `nail-tryon:upload:client:${input.clientId}`,
      ...NAIL_TRYON_UPLOAD_RATE_LIMITS.client,
    },
    {
      key: `nail-tryon:upload:salon:${input.salonId}`,
      ...NAIL_TRYON_UPLOAD_RATE_LIMITS.salon,
    },
  ];

  for (const check of checks) {
    try {
      const result = await hit(
        check.key,
        check.limit,
        check.windowSeconds,
      );
      if (result.error) return "unavailable";
      if (result.data !== true) return "limited";
    } catch {
      return "unavailable";
    }
  }

  return "allowed";
}
