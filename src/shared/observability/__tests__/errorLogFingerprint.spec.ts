import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  createServiceRoleClient: vi.fn(),
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

import { logError } from "@/shared/observability/errorLog";

describe("production error fingerprint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    mocks.createServiceRoleClient.mockReturnValue({ rpc: mocks.rpc });
  });

  it("does not collapse the same React error across different routes", async () => {
    const message = "Error: Minified React error #418";

    await logError({
      message,
      surface: "client",
      route: "/choose-salon",
    });
    await logError({
      message,
      surface: "client",
      route: "/dashboard/hilite-anaheim/center",
    });

    const first = mocks.rpc.mock.calls[0]?.[1] as { p_fingerprint: string };
    const second = mocks.rpc.mock.calls[1]?.[1] as { p_fingerprint: string };
    expect(first.p_fingerprint).not.toBe(second.p_fingerprint);
  });

  it("still groups variable ids from the same route and error shape", async () => {
    await logError({
      message: "Booking 123 failed for 11111111-1111-4111-8111-111111111111",
      surface: "server",
      route: "/api/booking",
    });
    await logError({
      message: "Booking 987 failed for 22222222-2222-4222-8222-222222222222",
      surface: "server",
      route: "/api/booking",
    });

    const first = mocks.rpc.mock.calls[0]?.[1] as { p_fingerprint: string };
    const second = mocks.rpc.mock.calls[1]?.[1] as { p_fingerprint: string };
    expect(first.p_fingerprint).toBe(second.p_fingerprint);
  });

  it("stores the same bounded route used to create the fingerprint", async () => {
    const route = `/${"x".repeat(400)}`;

    await logError({
      message: "bounded route evidence",
      surface: "client",
      route,
    });

    const payload = mocks.rpc.mock.calls[0]?.[1] as {
      p_route: string;
      p_fingerprint: string;
    };
    expect(payload.p_route).toHaveLength(300);
    expect(payload.p_fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});
