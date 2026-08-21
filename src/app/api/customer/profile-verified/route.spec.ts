import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rate: vi.fn(),
  service: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/security/publicServerActionRateLimit", () => ({
  consumePublicRequestRateLimit: mocks.rate,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.service,
}));

import { GET } from "./route";

function request() {
  return new Request(
    "https://nailiq.test/api/customer/profile-verified?otp_session_id=11111111-1111-4111-8111-111111111111&phone=%2B16045550199&salon_id=22222222-2222-4222-8222-222222222222",
    { headers: { "x-forwarded-for": "198.51.100.9" } },
  );
}

describe("verified customer profile rate boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rate.mockResolvedValue("allowed");
  });

  it.each([
    ["limited", 429],
    ["unavailable", 503],
  ] as const)("returns %s before service-role reads", async (result, status) => {
    mocks.rate.mockResolvedValueOnce(result);
    const response = await GET(request());
    expect(response.status).toBe(status);
    expect(mocks.service).not.toHaveBeenCalled();
  });
});
