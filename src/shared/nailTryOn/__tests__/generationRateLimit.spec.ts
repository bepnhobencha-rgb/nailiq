import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  checkNailTryOnGenerationRateLimit,
  NAIL_TRYON_GENERATION_RATE_LIMITS,
} from "@/shared/nailTryOn/generationRateLimit";

const input = { salonId: "salon-1", sessionId: "session-1" };

describe("Nail Try-On generation rate limit", () => {
  it("requires both the session and salon checks to allow the request", async () => {
    const hit = vi.fn(async () => ({ data: true, error: null }));

    await expect(
      checkNailTryOnGenerationRateLimit(hit, input),
    ).resolves.toBe("allowed");
    expect(hit).toHaveBeenNthCalledWith(
      1,
      "nail-tryon:generate:session:session-1",
      NAIL_TRYON_GENERATION_RATE_LIMITS.session.limit,
      NAIL_TRYON_GENERATION_RATE_LIMITS.session.windowSeconds,
    );
    expect(hit).toHaveBeenNthCalledWith(
      2,
      "nail-tryon:generate:salon:salon-1",
      NAIL_TRYON_GENERATION_RATE_LIMITS.salon.limit,
      NAIL_TRYON_GENERATION_RATE_LIMITS.salon.windowSeconds,
    );
  });

  it("stops before the salon check when the session is over its limit", async () => {
    const hit = vi.fn(async () => ({ data: false, error: null }));

    await expect(
      checkNailTryOnGenerationRateLimit(hit, input),
    ).resolves.toBe("limited");
    expect(hit).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the atomic limiter is unavailable", async () => {
    const hit = vi.fn(async () => ({
      data: null,
      error: { code: "database_unavailable" },
    }));

    await expect(
      checkNailTryOnGenerationRateLimit(hit, input),
    ).resolves.toBe("unavailable");
  });

  it("fails closed when the limiter throws", async () => {
    const hit = vi.fn(async () => {
      throw new Error("network unavailable");
    });

    await expect(
      checkNailTryOnGenerationRateLimit(hit, input),
    ).resolves.toBe("unavailable");
  });
});
