import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ checkRateLimit: vi.fn() }));

vi.mock("@vercel/firewall", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));

describe("programmatic Vercel firewall lookup", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.checkRateLimit.mockReset();
  });

  it("briefly reuses a missing-rule result without blocking traffic", async () => {
    mocks.checkRateLimit.mockResolvedValue({
      rateLimited: false,
      error: "not-found",
    });
    const { isRateLimited, RATE_LIMIT_IDS } = await import("../rateLimit");

    await expect(isRateLimited(RATE_LIMIT_IDS.bookingPageLoad)).resolves.toBe(
      false,
    );
    await expect(isRateLimited(RATE_LIMIT_IDS.bookingPageLoad)).resolves.toBe(
      false,
    );

    expect(mocks.checkRateLimit).toHaveBeenCalledOnce();
  });

  it("never caches a configured rule decision", async () => {
    mocks.checkRateLimit
      .mockResolvedValueOnce({ rateLimited: true, error: "blocked" })
      .mockResolvedValueOnce({ rateLimited: false });
    const { isRateLimited, RATE_LIMIT_IDS } = await import("../rateLimit");

    await expect(isRateLimited(RATE_LIMIT_IDS.authAttempt)).resolves.toBe(true);
    await expect(isRateLimited(RATE_LIMIT_IDS.authAttempt)).resolves.toBe(
      false,
    );
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(2);
  });

  it("fails open when the SDK lookup throws", async () => {
    mocks.checkRateLimit.mockRejectedValue(new Error("unavailable"));
    const { isRateLimited, RATE_LIMIT_IDS } = await import("../rateLimit");

    await expect(isRateLimited(RATE_LIMIT_IDS.contactSubmit)).resolves.toBe(
      false,
    );
  });
});
