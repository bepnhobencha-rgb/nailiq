import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rate: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  service: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/security/publicServerActionRateLimit", () => ({
  consumePublicRequestRateLimit: mocks.rate,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.service,
}));

import { POST } from "./route";

const body = {
  salon_id: "11111111-1111-4111-8111-111111111111",
  phone: "+16045550199",
  session_id: "33333333-3333-4333-8333-333333333333",
  otp_session_id: "44444444-4444-4444-8444-444444444444",
  outcome: "dismissed",
};

function request(
  patch: Record<string, unknown> = {},
  headers: Record<string, string> = { origin: "https://nailiq.test" },
) {
  return new Request("https://nailiq.test/api/upsell/outcome", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ ...body, ...patch }),
  });
}

describe("POST /api/upsell/outcome attribution boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rate.mockResolvedValue("allowed");
    mocks.service.mockReturnValue({ rpc: mocks.rpc, from: mocks.from });
  });

  it("rejects missing and cross-origin requests before rate limit or database access", async () => {
    const missing = await POST(request({}, {}));
    const attacker = await POST(request({}, { origin: "https://evil.example" }));

    expect(missing.status).toBe(403);
    expect(attacker.status).toBe(403);
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it.each(["shown", "accepted", "forged"])(
    "does not let a browser self-assert the %s outcome",
    async (outcome) => {
      const result = await POST(request({ outcome }));

      expect(result.status).toBe(400);
      expect(mocks.service).not.toHaveBeenCalled();
    },
  );

  it("does not accept caller-controlled added revenue", async () => {
    const result = await POST(request({ added_revenue_cents: 9_999 }));

    expect(result.status).toBe(400);
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it("rejects an invalid exact OTP capability before touching the outcome log", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });

    const result = await POST(request());

    expect(result.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("updates only the exact capability-bound shown row for a customer dismissal", async () => {
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    const eq = vi.fn();
    const chain = {
      eq,
      select: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: "55555555-5555-4555-8555-555555555555" },
        error: null,
      }),
    };
    eq.mockReturnValue(chain);
    chain.select.mockReturnValue(chain);
    mocks.from.mockReturnValue({ update: vi.fn(() => chain) });

    const result = await POST(request());

    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true });
    expect(eq).toHaveBeenCalledWith("salon_id", body.salon_id);
    expect(eq).toHaveBeenCalledWith("client_phone", "16045550199");
    expect(eq).toHaveBeenCalledWith("session_id", body.session_id);
    expect(eq).toHaveBeenCalledWith("outcome", "shown");
  });
});
