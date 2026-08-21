import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  create: vi.fn(),
  quote: vi.fn(),
  rateLimit: vi.fn(),
  ensureCard: vi.fn(),
  mintCard: vi.fn(),
  saveCard: vi.fn(),
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
      pricing: { authoritative: pricing },
    });
    expect(mocks.serialize).toHaveBeenCalledWith(pricing);
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

  it("reports a committed booking as card_management_pending when required mint fails", async () => {
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
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "card_management_pending",
      bookingCommitted: true,
    });
    expect(mocks.saveCard).not.toHaveBeenCalled();
  });
});
