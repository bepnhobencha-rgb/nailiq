import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  create: vi.fn(),
  quote: vi.fn(),
  rateLimit: vi.fn(),
  ensureCard: vi.fn(),
  mintCard: vi.fn(),
  saveCard: vi.fn(),
  recordCardPending: vi.fn(),
  resolveCardContinuation: vi.fn(),
  serialize: vi.fn((value: unknown) => ({ authoritative: value })),
}));

vi.mock("server-only", () => ({}));
vi.mock(
  "@/shared/booking/groupBookingPricingServer",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("@/shared/booking/groupBookingPricingServer")
    >();
    return {
      ...actual,
      authorizeGroupBookingBoundary: mocks.authorize,
      createGroupBookingsAuthoritative: mocks.create,
      resolveGroupBookingQuote: mocks.quote,
    };
  },
);
vi.mock("@/shared/noshow/ensureNoShowCardRequirement", () => ({
  ensureNoShowCardRequirement: mocks.ensureCard,
}));
vi.mock("@/shared/booking/bookingManagementCapabilities", () => ({
  mintBookingManagementCapability: mocks.mintCard,
}));
vi.mock("@/shared/booking/bookingCardManagement", () => ({
  saveCardWithManagementCapability: mocks.saveCard,
}));
vi.mock("@/shared/booking/bookingCardContinuation", () => ({
  recordCommittedBookingCardPending: mocks.recordCardPending,
  resolveCommittedBookingCardContinuation: mocks.resolveCardContinuation,
}));
vi.mock(
  "@/shared/booking/groupBookingApiBoundary",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("@/shared/booking/groupBookingApiBoundary")
    >();
    return { ...actual, groupBookingRateLimitAllowed: mocks.rateLimit };
  },
);
vi.mock(
  "@/shared/booking/groupBookingPricing",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("@/shared/booking/groupBookingPricing")
    >();
    return { ...actual, serializeGroupBookingPricingQuote: mocks.serialize };
  },
);

import { POST as quotePost } from "@/app/api/booking/group-quote/route";
import { POST as createPost } from "@/app/api/booking/group-create/route";

const validBody = {
  salonId: "11111111-1111-4111-8111-111111111111",
  bookings: [
    {
      serviceId: "21111111-1111-4111-8111-111111111111",
      staffId: "31111111-1111-4111-8111-111111111111",
      startTimeUtc: "2026-08-21T17:00:00.000Z",
      endTimeUtc: "2026-08-21T18:00:00.000Z",
      addonServiceIds: [],
      clientName: "Mai",
      clientPhone: "16045550100",
      clientEmail: "mai@example.test",
    },
    {
      serviceId: "41111111-1111-4111-8111-111111111111",
      staffId: "51111111-1111-4111-8111-111111111111",
      startTimeUtc: "2026-08-21T17:00:00.000Z",
      endTimeUtc: "2026-08-21T18:00:00.000Z",
      addonServiceIds: [],
      clientName: "Lan",
      clientPhone: null,
      clientEmail: null,
    },
  ],
  voucherCode: null,
  applyEmailDiscount: true,
};

function request(
  path: "group-quote" | "group-create",
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new NextRequest(`http://localhost/api/booking/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("public group pricing route boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateLimit.mockResolvedValue(true);
    mocks.authorize.mockResolvedValue({ ok: true, phoneOtpEnabled: true });
    mocks.quote.mockResolvedValue({ ok: false, code: "quote_unavailable" });
    mocks.create.mockResolvedValue({ ok: false, code: "idempotency_conflict" });
    mocks.ensureCard.mockResolvedValue({ required: false, feeCents: 0 });
    mocks.mintCard.mockResolvedValue({
      ok: true,
      capability: {
        tokenId: "b1111111-1111-4111-8111-111111111111",
        action: "card_manage",
        scopeKind: "organizer_own",
        epoch: 1,
        expiresAt: "2026-08-21T00:00:00.000Z",
        reused: false,
      },
    });
    mocks.saveCard.mockResolvedValue({ ok: true, code: "saved" });
    mocks.recordCardPending.mockResolvedValue(true);
    mocks.resolveCardContinuation.mockResolvedValue(true);
  });

  describe("group quote 503 diagnostics", () => {
    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    const failures = [
      { stage: "ip_metering", outcome: "quote_unavailable", rates: [null] },
      { stage: "phone_metering", outcome: "quote_unavailable", rates: [true, null] },
      { stage: "authorization", outcome: "booking_unavailable", rates: [true, true] },
      { stage: "quote_resolution", outcome: "quote_unavailable", rates: [true, true] },
      { stage: "quote_resolution", outcome: "slot_conflict", rates: [true, true] },
      { stage: "quote_resolution", outcome: "pricing_invalid", rates: [true, true] },
    ] as const;

    function arrangeFailure(failure: typeof failures[number]) {
      failure.rates.forEach((allowed) => mocks.rateLimit.mockResolvedValueOnce(allowed));
      if (failure.stage === "authorization") {
        mocks.authorize.mockResolvedValueOnce({
          ok: false,
          code: "booking_unavailable",
          error: new Error("private dependency detail"),
          token: "private-token",
        });
      }
      if (failure.stage === "quote_resolution") {
        mocks.quote.mockResolvedValueOnce({ ok: false, code: failure.outcome });
      }
    }

    it.each(failures)("records only fixed metadata for $stage / $outcome", async (failure) => {
      arrangeFailure(failure);
      const response = await quotePost(request("group-quote", validBody, {
        "x-forwarded-for": "192.0.2.17",
        "x-vercel-id": "untrusted-request-id",
        cookie: "session=private-session",
      }));
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("retry-after")).toBeNull();
      await expect(response.json()).resolves.toEqual({ ok: false, code: failure.outcome });
      // Exact keys/values rule out accidentally including request/customer data
      // or the authorization object's raw error/token in the structured line.
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
        event: "group_quote_unavailable",
        status: 503,
        stage: failure.stage,
        outcome: failure.outcome,
      }));
      expect(mocks.rateLimit).toHaveBeenCalledTimes(failure.rates.length);
      expect(mocks.quote).toHaveBeenCalledTimes(failure.stage === "quote_resolution" ? 1 : 0);
      expect(mocks.authorize).toHaveBeenCalledTimes(
        failure.stage === "authorization" || failure.stage === "quote_resolution" ? 1 : 0,
      );
    });

    it("never logs an unexpected runtime outcome string", async () => {
      const code = "private phone 16045550100 token=private-token";
      mocks.quote.mockResolvedValueOnce({ ok: false, code });
      const response = await quotePost(request("group-quote", validBody));
      expect(response.status).toBe(503);
      // Preserve the existing response contract even for an unexpected result;
      // only diagnostic metadata is normalized to a fixed vocabulary.
      await expect(response.json()).resolves.toEqual({ ok: false, code });
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
        event: "group_quote_unavailable",
        status: 503,
        stage: "quote_resolution",
        outcome: "unrecognized_failure",
      }));
    });

    it.each(failures)("preserves $stage / $outcome when the log sink throws", async (failure) => {
      arrangeFailure(failure);
      vi.mocked(console.warn).mockImplementation(() => { throw new Error("sink unavailable"); });
      const response = await quotePost(request("group-quote", validBody));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ ok: false, code: failure.outcome });
    });

    it.each([
      { label: "success", status: 200 },
      { label: "forbidden origin", status: 403 },
      { label: "invalid length", status: 400 },
      { label: "invalid schema", status: 400 },
      { label: "IP quota exhausted", status: 429 },
      { label: "phone quota exhausted", status: 429 },
      { label: "resolver invalid request", status: 400 },
      { label: "invalid voucher", status: 422 },
    ])("does not emit a 503 diagnostic for $label", async ({ label, status }) => {
      const req = request("group-quote", label === "invalid schema" ? {} : validBody);
      if (label === "forbidden origin") req.headers.delete("origin");
      if (label === "invalid length") req.headers.set("content-length", "65537");
      if (label === "IP quota exhausted") mocks.rateLimit.mockResolvedValueOnce(false);
      if (label === "phone quota exhausted") {
        mocks.rateLimit.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      }
      if (label === "success") mocks.quote.mockResolvedValueOnce({ ok: true, quote: {} });
      if (label === "resolver invalid request") {
        mocks.quote.mockResolvedValueOnce({ ok: false, code: "invalid_request" });
      }
      if (label === "invalid voucher") {
        mocks.quote.mockResolvedValueOnce({ ok: false, code: "voucher_invalid" });
      }
      const response = await quotePost(req);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("retry-after")).toBe(status === 429 ? "300" : null);
      expect(console.warn).not.toHaveBeenCalled();
    });

    it("does not swallow or log raw unhandled dependency exceptions", async () => {
      const error = new Error("private dependency detail");
      mocks.quote.mockRejectedValueOnce(error);
      await expect(quotePost(request("group-quote", validBody))).rejects.toBe(error);
      expect(console.warn).not.toHaveBeenCalled();
    });
  });

  it("denies missing and cross-site origins before rate or pricing work", async () => {
    const noOrigin = request("group-quote", validBody);
    noOrigin.headers.delete("origin");
    expect((await quotePost(noOrigin)).status).toBe(403);

    const crossSite = request("group-create", {
      ...validBody,
      idempotencyKey: "61111111-1111-4111-8111-111111111111",
      expectedPricingFingerprint: "a".repeat(64),
      otpSessionId: "71111111-1111-4111-8111-111111111111",
    }, { "sec-fetch-site": "cross-site" });
    expect((await createPost(crossSite)).status).toBe(403);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("fails closed when durable IP metering is unavailable", async () => {
    mocks.rateLimit.mockResolvedValueOnce(null);
    const response = await quotePost(request("group-quote", validBody));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "quote_unavailable",
    });
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.quote).not.toHaveBeenCalled();
  });

  it("rejects legacy top-level identity spoofing before authorization", async () => {
    const response = await quotePost(
      request("group-quote", {
        ...validBody,
        clientPhone: "16045559999",
        clientEmail: "spoofed@example.test",
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.quote).not.toHaveBeenCalled();
  });

  it("derives quote authorization and phone metering from member zero", async () => {
    const response = await quotePost(request("group-quote", validBody));
    expect(response.status).toBe(503);
    expect(mocks.rateLimit).toHaveBeenCalledTimes(2);
    expect(mocks.rateLimit.mock.calls[1][0]).not.toContain("16045550100");
    expect(mocks.authorize).toHaveBeenCalledWith({
      salonId: validBody.salonId,
      organizerPhone: "16045550100",
      requireOtp: false,
    });
    expect(mocks.quote).toHaveBeenCalledWith(
      expect.objectContaining({
        bookings: expect.arrayContaining([
          expect.objectContaining({ clientPhone: "16045550100" }),
        ]),
      }),
    );
  });

  it("returns the exact authoritative quote receipt on success", async () => {
    const quote = { receipt: "quote" };
    mocks.quote.mockResolvedValueOnce({ ok: true, quote });

    const response = await quotePost(request("group-quote", validBody));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      quote: { authoritative: quote },
    });
    expect(mocks.serialize).toHaveBeenCalledWith(quote);
  });

  it("rejects a malformed create fingerprint before OTP or create", async () => {
    const response = await createPost(
      request("group-create", {
        ...validBody,
        idempotencyKey: "61111111-1111-4111-8111-111111111111",
        expectedPricingFingerprint: "tampered",
        otpSessionId: "71111111-1111-4111-8111-111111111111",
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("binds create OTP to organizer identity and preserves conflict truth", async () => {
    const body = {
      ...validBody,
      idempotencyKey: "61111111-1111-4111-8111-111111111111",
      expectedPricingFingerprint: "a".repeat(64),
      otpSessionId: "71111111-1111-4111-8111-111111111111",
    };
    const response = await createPost(request("group-create", body));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "idempotency_conflict",
    });
    expect(mocks.authorize).toHaveBeenCalledWith({
      salonId: validBody.salonId,
      organizerPhone: "16045550100",
      otpSessionId: body.otpSessionId,
      requireOtp: true,
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPricingFingerprint: "a".repeat(64),
        bookings: expect.arrayContaining([
          expect.objectContaining({ clientPhone: "16045550100" }),
        ]),
      }),
    );
  });

  it("returns IDs, replay truth, and the exact authoritative create receipt", async () => {
    const pricing = { receipt: "create" };
    mocks.create.mockResolvedValueOnce({
      ok: true,
      groupId: "81111111-1111-4111-8111-111111111111",
      bookingIds: [
        "91111111-1111-4111-8111-111111111111",
        "a1111111-1111-4111-8111-111111111111",
      ],
      idempotent: true,
      pricing,
    });
    const body = {
      ...validBody,
      idempotencyKey: "61111111-1111-4111-8111-111111111111",
      expectedPricingFingerprint: "a".repeat(64),
      otpSessionId: "71111111-1111-4111-8111-111111111111",
    };

    const response = await createPost(request("group-create", body));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      groupId: "81111111-1111-4111-8111-111111111111",
      bookingIds: [
        "91111111-1111-4111-8111-111111111111",
        "a1111111-1111-4111-8111-111111111111",
      ],
      idempotent: true,
      cardManagementToken: null,
      cardManagementPending: false,
      pricing: { authoritative: pricing },
    });
    expect(mocks.serialize).toHaveBeenCalledWith(pricing);
    expect(mocks.resolveCardContinuation).toHaveBeenCalledWith({
      salonId: validBody.salonId,
      bookingId: "91111111-1111-4111-8111-111111111111",
      createIdempotencyKey: body.idempotencyKey,
      pricingFingerprint: body.expectedPricingFingerprint,
      scope: "group_organizer",
      reason: "card_not_required",
    });
  });

  it("returns only the organizer card_manage token when policy requires post-booking capture", async () => {
    const pricing = { receipt: "create" };
    mocks.create.mockResolvedValueOnce({
      ok: true,
      groupId: "81111111-1111-4111-8111-111111111111",
      bookingIds: ["91111111-1111-4111-8111-111111111111", "a1111111-1111-4111-8111-111111111111"],
      idempotent: false,
      pricing,
    });
    mocks.ensureCard.mockResolvedValueOnce({ required: true, feeCents: 2500 });
    const body = {
      ...validBody,
      idempotencyKey: "61111111-1111-4111-8111-111111111111",
      expectedPricingFingerprint: "a".repeat(64),
      otpSessionId: "71111111-1111-4111-8111-111111111111",
    };

    const response = await createPost(request("group-create", body));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      cardManagementToken: "b1111111-1111-4111-8111-111111111111",
    });
    expect(mocks.mintCard).toHaveBeenCalledWith(expect.objectContaining({
      salonId: validBody.salonId,
      bookingId: "91111111-1111-4111-8111-111111111111",
      action: "card_manage",
    }));
    expect(mocks.saveCard).not.toHaveBeenCalled();
  });

  it("saves a pre-captured organizer card durably before acknowledging group success", async () => {
    const pricing = { receipt: "create" };
    mocks.create.mockResolvedValueOnce({
      ok: true,
      groupId: "81111111-1111-4111-8111-111111111111",
      bookingIds: ["91111111-1111-4111-8111-111111111111", "a1111111-1111-4111-8111-111111111111"],
      idempotent: true,
      pricing,
    });
    mocks.ensureCard.mockResolvedValueOnce({ required: true, feeCents: 2500 });
    const body = {
      ...validBody,
      idempotencyKey: "61111111-1111-4111-8111-111111111111",
      expectedPricingFingerprint: "a".repeat(64),
      otpSessionId: "71111111-1111-4111-8111-111111111111",
      cardSourceId: "cnon:group-card",
      cardVerificationToken: "verf-group",
      noShowConsent: true,
    };

    const response = await createPost(request("group-create", body));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, cardManagementToken: null });
    expect(mocks.saveCard).toHaveBeenCalledWith({
      tokenId: "b1111111-1111-4111-8111-111111111111",
      requestId: body.idempotencyKey,
      provider: "square",
      sourceToken: body.cardSourceId,
      verificationToken: body.cardVerificationToken,
    });
  });

  it("acknowledges a committed booking when required card management is pending", async () => {
    mocks.create.mockResolvedValueOnce({
      ok: true,
      groupId: "81111111-1111-4111-8111-111111111111",
      bookingIds: ["91111111-1111-4111-8111-111111111111", "a1111111-1111-4111-8111-111111111111"],
      idempotent: true,
      pricing: { receipt: "create" },
    });
    mocks.ensureCard.mockResolvedValueOnce({ required: true, feeCents: 2500 });
    mocks.mintCard.mockResolvedValueOnce({ ok: false, code: "management_unavailable" });
    const response = await createPost(request("group-create", {
      ...validBody,
      idempotencyKey: "61111111-1111-4111-8111-111111111111",
      expectedPricingFingerprint: "a".repeat(64),
      otpSessionId: "71111111-1111-4111-8111-111111111111",
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      groupId: "81111111-1111-4111-8111-111111111111",
      bookingIds: [
        "91111111-1111-4111-8111-111111111111",
        "a1111111-1111-4111-8111-111111111111",
      ],
      idempotent: true,
      cardManagementToken: null,
      cardManagementPending: true,
      pricing: { authoritative: { receipt: "create" } },
    });
    expect(mocks.saveCard).not.toHaveBeenCalled();
  });

  it("acknowledges a committed booking when pre-captured card saving fails", async () => {
    const pricing = { receipt: "create" };
    mocks.create.mockResolvedValueOnce({
      ok: true,
      groupId: "81111111-1111-4111-8111-111111111111",
      bookingIds: ["91111111-1111-4111-8111-111111111111", "a1111111-1111-4111-8111-111111111111"],
      idempotent: false,
      pricing,
    });
    mocks.ensureCard.mockResolvedValueOnce({ required: true, feeCents: 2500 });
    mocks.saveCard.mockResolvedValueOnce({ ok: false, code: "provider_unavailable" });
    const body = {
      ...validBody,
      idempotencyKey: "61111111-1111-4111-8111-111111111111",
      expectedPricingFingerprint: "a".repeat(64),
      otpSessionId: "71111111-1111-4111-8111-111111111111",
      cardSourceId: "cnon:group-card",
      cardVerificationToken: "verf-group",
      noShowConsent: true,
    };

    const response = await createPost(request("group-create", body));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      groupId: "81111111-1111-4111-8111-111111111111",
      bookingIds: expect.arrayContaining([
        "91111111-1111-4111-8111-111111111111",
        "a1111111-1111-4111-8111-111111111111",
      ]),
      cardManagementToken: null,
      cardManagementPending: true,
      pricing: { authoritative: pricing },
    });
    expect(mocks.recordCardPending).toHaveBeenLastCalledWith(expect.objectContaining({
      bookingId: "91111111-1111-4111-8111-111111111111",
      stage: "provider_handoff",
      reason: "card_save_unresolved",
    }));
  });

  it("still returns committed group success when card saving unexpectedly throws", async () => {
    mocks.create.mockResolvedValueOnce({
      ok: true,
      groupId: "81111111-1111-4111-8111-111111111111",
      bookingIds: ["91111111-1111-4111-8111-111111111111", "a1111111-1111-4111-8111-111111111111"],
      idempotent: false,
      pricing: { receipt: "create" },
    });
    mocks.ensureCard.mockResolvedValueOnce({ required: true, feeCents: 2500 });
    mocks.saveCard.mockRejectedValueOnce(new Error("unexpected transport failure"));

    const response = await createPost(request("group-create", {
      ...validBody,
      idempotencyKey: "61111111-1111-4111-8111-111111111111",
      expectedPricingFingerprint: "a".repeat(64),
      otpSessionId: "71111111-1111-4111-8111-111111111111",
      cardSourceId: "cnon:group-card",
      noShowConsent: true,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      cardManagementToken: null,
      cardManagementPending: true,
    });
    expect(mocks.recordCardPending).toHaveBeenLastCalledWith(expect.objectContaining({
      stage: "provider_handoff",
      reason: "unexpected_post_commit_error",
    }));
  });
});
