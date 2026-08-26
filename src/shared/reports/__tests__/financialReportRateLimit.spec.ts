import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ service: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: mocks.service }));

import { checkFinancialReportRateLimits } from "../financialReportRateLimit";

describe("financial report durable meters", () => {
  const rpc = vi.fn();
  beforeEach(() => { vi.clearAllMocks(); mocks.service.mockReturnValue({ rpc }); rpc.mockResolvedValue({ data: true, error: null }); });

  it("requires both hashed actor and salon meters", async () => {
    await expect(checkFinancialReportRateLimits("actor-secret", "salon-secret", "export")).resolves.toBe("allowed");
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_limit: 8, p_window_seconds: 300 });
    expect(rpc.mock.calls[1]?.[1]).toMatchObject({ p_limit: 30, p_window_seconds: 3600 });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("actor-secret"); expect(JSON.stringify(rpc.mock.calls)).not.toContain("salon-secret");
  });

  it.each([
    [{ data: false, error: null }, "rate_limited"],
    [{ data: null, error: null }, "unavailable"],
    [{ data: true, error: { message: "down" } }, "unavailable"],
  ] as const)("fails closed for threshold/error/null", async (reply, expected) => {
    rpc.mockResolvedValueOnce(reply);
    await expect(checkFinancialReportRateLimits("actor", "salon", "load")).resolves.toBe(expected);
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("fails closed when the limiter throws", async () => {
    rpc.mockRejectedValueOnce(new Error("down"));
    await expect(checkFinancialReportRateLimits("actor", "salon", "load")).resolves.toBe("unavailable");
    expect(rpc).toHaveBeenCalledOnce();
  });
});
