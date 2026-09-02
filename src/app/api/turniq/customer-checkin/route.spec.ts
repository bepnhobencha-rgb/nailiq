import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  origin: vi.fn(),
  rate: vi.fn(),
  record: vi.fn(),
}));

vi.mock("@/shared/security/sameOriginMutation", () => ({
  isSameOriginMutation: mocks.origin,
}));
vi.mock("@/shared/security/publicServerActionRateLimit", () => ({
  consumePublicRequestRateLimit: mocks.rate,
}));
vi.mock("@/shared/turniq/customerCheckInServer", () => ({
  recordTurnIqCustomerCheckInShadow: mocks.record,
}));

import { POST } from "./route";

const BODY = {
  capabilityToken: "99999999-9999-4999-8999-999999999999",
  commandId: "11111111-1111-4111-8111-111111111111",
  channel: "qr",
  visitKind: "booked",
  serviceId: "22222222-2222-4222-8222-222222222222",
  partySize: 1,
  submittedAt: "2026-09-02T18:00:00.000Z",
  actorSessionFingerprint: "a".repeat(64),
  requestedTechnician: null,
};

function request(body: unknown = BODY) {
  return new Request("https://nailiq.test/api/turniq/customer-checkin", {
    method: "POST",
    headers: { origin: "https://nailiq.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/turniq/customer-checkin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.origin.mockReturnValue(true);
    mocks.rate.mockResolvedValue("allowed");
    mocks.record.mockResolvedValue({
      ok: true,
      replayed: false,
      status: "shadow_received",
      nextRoute: "single_engine_candidate",
      intakeFingerprint: "b".repeat(64),
      message: { en: "Received.", vi: "Đã nhận." },
    });
  });

  it("applies IP and capability limits before the shadow ledger", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      status: "shadow_received",
      nextRoute: "single_engine_candidate",
    });
    expect(mocks.rate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      scope: "turniq-customer-checkin",
    }));
    expect(mocks.rate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      scope: "turniq-customer-checkin-capability",
      identity: [BODY.capabilityToken],
    }));
    expect(mocks.rate.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.record.mock.invocationCallOrder[0],
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("rejects cross-origin requests before rate or body work", async () => {
    mocks.origin.mockReturnValue(false);
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("fails closed before ledger work when either durable limit is unavailable", async () => {
    mocks.rate.mockResolvedValueOnce("allowed").mockResolvedValueOnce("unavailable");
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("rejects oversized or malformed requests without capability ledger work", async () => {
    const response = await POST(request({ ...BODY, padding: "x".repeat(5_000) }));
    expect(response.status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("does not expose internal IDs or provider material", async () => {
    const response = await POST(request());
    const body = await response.json();
    expect(JSON.stringify(body)).not.toMatch(
      /salonId|bookingId|staffId|receiptId|token|phone|email|square|stripe/i,
    );
  });
});
