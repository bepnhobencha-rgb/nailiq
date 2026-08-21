import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rate: vi.fn(),
  push: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/security/publicServerActionRateLimit", () => ({
  consumePublicRequestRateLimit: mocks.rate,
}));
vi.mock("@/shared/integrations/wix/writeback", () => ({
  pushWixCreate: mocks.push,
}));

import { POST } from "./route";

const bookingId = "11111111-1111-4111-8111-111111111111";
const salonId = "22222222-2222-4222-8222-222222222222";

function request() {
  return new Request("https://nailiq.test/api/booking/wix-create", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.8" },
    body: JSON.stringify({ bookingId, salonId }),
  });
}

describe("Wix create public rate boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rate.mockResolvedValue("allowed");
    mocks.push.mockResolvedValue(undefined);
  });

  it.each([
    ["limited", 429],
    ["unavailable", 503],
  ] as const)("returns %s before any provider call", async (result, status) => {
    mocks.rate.mockResolvedValueOnce(result);
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("checks both IP and booking buckets before the provider", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.rate).toHaveBeenCalledTimes(2);
    expect(mocks.push).toHaveBeenCalledWith(salonId, bookingId);
    expect(mocks.rate.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.push.mock.invocationCallOrder[0],
    );
  });
});
