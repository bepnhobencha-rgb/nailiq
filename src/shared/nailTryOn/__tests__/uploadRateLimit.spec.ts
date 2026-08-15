import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  checkNailTryOnUploadRateLimit,
  nailTryOnClientLimiterId,
  NAIL_TRYON_UPLOAD_RATE_LIMITS,
} from "@/shared/nailTryOn/uploadRateLimit";

describe("Nail Try-On upload rate limit", () => {
  it("hashes the trusted forwarded client address without exposing it", () => {
    const headers = new Headers({
      "x-vercel-forwarded-for": "203.0.113.42, 10.0.0.1",
    });

    const identifier = nailTryOnClientLimiterId(headers);

    expect(identifier).toMatch(/^[a-f0-9]{24}$/);
    expect(identifier).not.toContain("203.0.113.42");
    expect(identifier).toBe(nailTryOnClientLimiterId(headers));
  });

  it("uses a stable conservative bucket when no proxy address is available", () => {
    expect(nailTryOnClientLimiterId(new Headers())).toBe(
      nailTryOnClientLimiterId(new Headers()),
    );
  });

  it("requires both client and salon limits to allow an upload", async () => {
    const hit = vi.fn(async () => ({ data: true, error: null }));

    await expect(checkNailTryOnUploadRateLimit(hit, {
      salonId: "salon-1",
      clientId: "client-hash",
    })).resolves.toBe("allowed");

    expect(hit).toHaveBeenNthCalledWith(
      1,
      "nail-tryon:upload:client:client-hash",
      NAIL_TRYON_UPLOAD_RATE_LIMITS.client.limit,
      NAIL_TRYON_UPLOAD_RATE_LIMITS.client.windowSeconds,
    );
    expect(hit).toHaveBeenNthCalledWith(
      2,
      "nail-tryon:upload:salon:salon-1",
      NAIL_TRYON_UPLOAD_RATE_LIMITS.salon.limit,
      NAIL_TRYON_UPLOAD_RATE_LIMITS.salon.windowSeconds,
    );
  });

  it("fails closed when the atomic limiter is unavailable", async () => {
    const hit = vi.fn(async () => ({
      data: null,
      error: { code: "database_unavailable" },
    }));

    await expect(checkNailTryOnUploadRateLimit(hit, {
      salonId: "salon-1",
      clientId: "client-hash",
    })).resolves.toBe("unavailable");
  });
});
