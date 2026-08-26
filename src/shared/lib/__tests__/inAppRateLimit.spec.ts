import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  createServiceRoleClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

import {
  clientIpFromHeaders,
  durableRateLimitKey,
  isOverRateLimit,
} from "@/shared/lib/inAppRateLimit";

describe("durable in-app rate limiting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createServiceRoleClient.mockReturnValue({ rpc: mocks.rpc });
  });

  it("maps the atomic RPC allow/deny result", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(
      isOverRateLimit("key", 3, 60, { failureMode: "block" }),
    ).resolves.toBe(false);
    mocks.rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(
      isOverRateLimit("key", 3, 60, { failureMode: "block" }),
    ).resolves.toBe(true);
  });

  it.each([
    { data: null, error: { message: "db down" } },
    { data: null, error: null },
    { data: "true", error: null },
  ])(
    "fails closed on unavailable or malformed RPC result %#",
    async (result) => {
      mocks.rpc.mockResolvedValueOnce(result);
      await expect(
        isOverRateLimit("cost-path", 2, 60, { failureMode: "block" }),
      ).resolves.toBe(true);
    },
  );

  it("keeps fail-open only when a caller explicitly uses the compatibility default", async () => {
    mocks.rpc.mockRejectedValueOnce(new Error("unavailable"));
    await expect(isOverRateLimit("low-risk", 2, 60)).resolves.toBe(false);
  });

  it("extracts only the first forwarded client address", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.7, 10.0.0.1",
      "x-real-ip": "198.51.100.9",
    });
    expect(clientIpFromHeaders(headers)).toBe("203.0.113.7");
    expect(
      clientIpFromHeaders(new Headers({ "x-real-ip": "198.51.100.9" })),
    ).toBe("198.51.100.9");
    expect(clientIpFromHeaders(new Headers())).toBe("unknown");
  });

  it("never persists raw caller material in a durable limiter key", () => {
    const ip = "203.0.113.7";
    const bookingId = "f64109b0-e3fd-4d7f-8471-81bcc31a1c56";
    const key = durableRateLimitKey("card-save", ip, bookingId);

    expect(key).toMatch(/^card-save:[a-f0-9]{64}$/);
    expect(key).not.toContain(ip);
    expect(key).not.toContain(bookingId);
    expect(key).toBe(durableRateLimitKey("card-save", ip, bookingId));
    expect(key).not.toBe(
      durableRateLimitKey("card-save", ip, `${bookingId}-other`),
    );
  });
});
