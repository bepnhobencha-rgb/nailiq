import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  replay: vi.fn(),
  readiness: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  after: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: mocks.after };
});
vi.mock("@/shared/booking/bookingSequenceServer", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/shared/booking/bookingSequenceServer")
  >();
  return {
    ...actual,
    createPublicBookingSequence: mocks.create,
    replayPublicBookingSequence: mocks.replay,
  };
});
vi.mock("@/shared/booking/bookingSequenceReadiness", () => ({
  loadPublicBookingSequenceReadiness: mocks.readiness,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc, from: mocks.from }),
}));
vi.mock("@/shared/booking/sendBookingConfirmationEmail", () => ({
  sendBookingConfirmationEmail: vi.fn(),
}));

import { POST } from "@/app/api/booking/sequence-create/route";

const ids = {
  salon: "11111111-1111-4111-8111-111111111111",
  request: "22222222-2222-4222-8222-222222222222",
  line: "33333333-3333-4333-8333-333333333333",
  service: "44444444-4444-4444-8444-444444444444",
  otp: "55555555-5555-4555-8555-555555555555",
  booking: "66666666-6666-4666-8666-666666666666",
};

function body(requestId = ids.request) {
  return {
    intent: {
      salonId: ids.salon,
      requestId,
      requestedStartTimeUtc: "2026-08-28T18:00:00.000Z",
      lines: [{
        lineId: ids.line,
        position: 0,
        serviceId: ids.service,
        staffPreference: "any",
        preferredResourceId: null,
        addOnServiceIds: [],
      }],
      sameStaffForAll: false,
      voucherCode: null,
      applyEmailDiscount: false,
      customer: { name: "Lan", phone: "+16045550123", email: null },
    },
    expectedPricingFingerprint: "a".repeat(64),
    otpSessionId: ids.otp,
    healthAcknowledged: true,
    smsConsent: true,
    language: "en",
  };
}

function request(value: unknown) {
  return new Request("http://localhost/api/booking/sequence-create", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
    },
    body: JSON.stringify(value),
  });
}

describe("sequence create atomic OTP and health boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    mocks.replay.mockResolvedValue({ ok: false, code: "replay_not_found" });
    mocks.readiness.mockResolvedValue({ ok: true });
    mocks.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: { phone_otp_enabled: true },
            error: null,
          }),
        }),
      }),
    });
    mocks.after.mockImplementation(() => undefined);
  });

  it("rejects cross-origin requests before replay, meters, or create", async () => {
    const crossOrigin = new Request("http://localhost/api/booking/sequence-create", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify(body()),
    });
    const response = await POST(crossOrigin as never);
    expect(response.status).toBe(403);
    expect(mocks.replay).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("fails closed on the first fresh-create meter without reaching readiness or create", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: false, error: null });
    const response = await POST(request(body()) as never);
    expect(response.status).toBe(429);
    expect(mocks.replay).toHaveBeenCalledTimes(1);
    expect(mocks.readiness).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("fails closed when replay lookup is unavailable instead of attempting a fresh create", async () => {
    mocks.replay.mockResolvedValueOnce({ ok: false, code: "create_unavailable" });
    const response = await POST(request(body()) as never);
    expect(response.status).toBe(503);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.readiness).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("requires the OTP bearer only after replay is definitively absent", async () => {
    const value = body();
    value.otpSessionId = null as never;
    const response = await POST(request(value) as never);
    expect(response.status).toBe(403);
    expect(mocks.replay).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("lets an exact consumed-session response-loss replay reach canonical create", async () => {
    const quote = { lines: [] };
    const firstResult = {
      ok: true,
      bookingId: ids.booking,
      segmentIds: [],
      idempotent: false,
      quote,
      salonSlug: "qa-sequence",
      smsConsent: true,
      language: "en",
    };
    mocks.create.mockResolvedValueOnce(firstResult);
    mocks.replay
      .mockResolvedValueOnce({ ok: false, code: "replay_not_found" })
      .mockResolvedValueOnce({ ...firstResult, idempotent: true });

    const first = await POST(request(body()) as never);
    const replay = await POST(request(body()) as never);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.replay).toHaveBeenCalledTimes(2);
    expect(mocks.replay.mock.calls[1]?.[0]).toEqual(mocks.create.mock.calls[0]?.[0]);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      otpSessionId: ids.otp,
      healthAcknowledged: true,
      smsConsent: true,
      language: "en",
    }));
    expect(mocks.replay.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.rpc.mock.invocationCallOrder[0]);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.readiness).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "validate_phone_otp_session",
      expect.anything(),
    );
  });

  it("rejects missing durable health material before canonical create", async () => {
    const value = body() as Record<string, unknown>;
    delete value.healthAcknowledged;
    const response = await POST(request(value) as never);
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("surfaces a changed-request replay conflict without post-commit effects", async () => {
    mocks.replay.mockResolvedValueOnce({ ok: false, code: "idempotency_conflict" });
    const response = await POST(
      request(body("77777777-7777-4777-8777-777777777777")) as never,
    );
    expect(response.status).toBe(409);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("rejects a consumed OTP reused across salons before any post-commit effect", async () => {
    const value = body();
    value.intent.salonId = "88888888-8888-4888-8888-888888888888";
    mocks.create.mockResolvedValueOnce({ ok: false, code: "invalid_otp_session" });

    const response = await POST(request(value) as never);

    expect(response.status).toBe(403);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      intent: expect.objectContaining({ salonId: value.intent.salonId }),
      otpSessionId: ids.otp,
    }));
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("uses persisted consent and language for committed replay side effects", async () => {
    // A fully committed response-loss replay must not consult any mutable/live
    // dependency; the zero-call assertions below are the executable boundary.
    mocks.replay.mockResolvedValueOnce({
      ok: true,
      bookingId: ids.booking,
      segmentIds: [],
      idempotent: true,
      quote: { lines: [] },
      salonSlug: "qa-sequence",
      smsConsent: false,
      language: "vi",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    mocks.after.mockImplementation((callback: () => unknown) => { void callback(); });

    const response = await POST(request(body()) as never);

    expect(response.status).toBe(200);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.readiness).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("/api/booking/sms-confirm"),
      expect.objectContaining({
        body: JSON.stringify({
          bookingId: ids.booking,
          salonId: ids.salon,
          language: "vi",
          smsConsent: false,
        }),
      }));
    fetchSpy.mockRestore();
  });

  it("fails closed when the authoritative create requires a durable health stamp", async () => {
    const value = body();
    value.healthAcknowledged = false;
    mocks.create.mockResolvedValueOnce({ ok: false, code: "health_ack_required" });

    const response = await POST(request(value) as never);

    expect(response.status).toBe(422);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      healthAcknowledged: false,
    }));
    expect(mocks.after).not.toHaveBeenCalled();
  });
});
