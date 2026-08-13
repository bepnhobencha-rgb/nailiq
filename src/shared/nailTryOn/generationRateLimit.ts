import "server-only";

export const NAIL_TRYON_GENERATION_RATE_LIMITS = {
  session: { limit: 5, windowSeconds: 60 * 60 },
  salon: { limit: 50, windowSeconds: 60 * 60 },
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

/**
 * Protect the paid image-generation endpoint with two independent limits.
 *
 * This deliberately fails closed: a limiter outage must not become unlimited
 * OpenAI image spend. Limits count attempts (including failed provider calls),
 * while plan quotas can separately count successful previews only.
 */
export async function checkNailTryOnGenerationRateLimit(
  hit: RateLimitHit,
  input: { salonId: string; sessionId: string },
): Promise<"allowed" | "limited" | "unavailable"> {
  const checks = [
    {
      key: `nail-tryon:generate:session:${input.sessionId}`,
      ...NAIL_TRYON_GENERATION_RATE_LIMITS.session,
    },
    {
      key: `nail-tryon:generate:salon:${input.salonId}`,
      ...NAIL_TRYON_GENERATION_RATE_LIMITS.salon,
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
