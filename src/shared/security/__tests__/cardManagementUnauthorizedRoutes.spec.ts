import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  decision: vi.fn(),
  ensure: vi.fn(),
  serviceRole: vi.fn(),
  squareConfig: vi.fn(),
  stripeCreate: vi.fn(),
  resolveProvider: vi.fn(),
  looseFrom: vi.fn(),
  inspect: vi.fn(),
  managementRate: vi.fn(),
  cardSave: vi.fn(),
  stripeSetup: vi.fn(),
  exchange: vi.fn(),
  overRate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/release/v1IntegrationScope", () => ({
  v1AllowsCustomerPaymentGateway: () => true,
}));
vi.mock("@/shared/security/sameOriginMutation", () => ({ isSameOriginMutation: () => true }));
vi.mock("@/shared/booking/bookingManagementCapabilities", () => ({
  inspectBookingManagementCapability: mocks.inspect,
  exchangePublicBookingCardManagementCapability: mocks.exchange,
}));
vi.mock("@/shared/booking/bookingManagementRateLimit", () => ({
  consumeBookingManagementRateLimit: mocks.managementRate,
}));
vi.mock("@/shared/booking/bookingCardManagement", () => ({
  saveCardWithManagementCapability: mocks.cardSave,
  createStripeSetupWithManagementCapability: mocks.stripeSetup,
}));
vi.mock("@/shared/lib/rateLimit", () => ({
  isRateLimited: vi.fn(async () => false),
  RATE_LIMIT_IDS: { cardSave: "card-save" },
}));
vi.mock("@/shared/lib/inAppRateLimit", () => ({
  clientIp: () => "127.0.0.1",
  durableRateLimitKey: (...parts: string[]) => parts.join(":"),
  isOverRateLimit: mocks.overRate,
}));
vi.mock("@/shared/integrations/square/noshow", () => ({
  saveNoShowCardForBooking: mocks.save,
  noShowCardDecision: mocks.decision,
}));
vi.mock("@/shared/noshow/ensureNoShowCardRequirement", () => ({
  ensureNoShowCardRequirement: mocks.ensure,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.serviceRole,
}));
vi.mock("@/shared/integrations/square/client", () => ({ getSquareConfig: mocks.squareConfig }));
vi.mock("@/shared/integrations/square/looseDb", () => ({
  looseServiceClient: () => ({ from: mocks.looseFrom }),
}));
vi.mock("@/shared/integrations/payments", () => ({ resolvePaymentProvider: mocks.resolveProvider }));
vi.mock("@/shared/lib/stripe", () => ({
  getStripeClient: () => ({ setupIntents: { create: mocks.stripeCreate } }),
}));

import { GET as squareConfigGet } from "@/app/api/booking/square-noshow-config/route";
import { POST as squareSavePost } from "@/app/api/booking/square-save-card/route";
import { POST as stripeSetupPost } from "@/app/api/booking/stripe-setup-intent/route";
import { POST as flagCardPost } from "@/app/api/booking/flag-noshow-card/route";
import { POST as cardCapabilityPost } from "@/app/api/booking/card-capability/route";

const BOOKING_ID = "11111111-1111-4111-8111-111111111111";
const SALON_ID = "22222222-2222-4222-8222-222222222222";
const IDEMPOTENCY_KEY = "33333333-3333-4333-8333-333333333333";
const PRICING_FINGERPRINT = "a".repeat(64);

function jsonRequest(pathname: string, body: Record<string, unknown>, contentLength?: string | null) {
  const encoded = JSON.stringify(body);
  const headers: Record<string, string> = {
    Origin: "https://nailiq.test",
    "Content-Type": "application/json",
  };
  if (contentLength !== null) {
    headers["Content-Length"] = contentLength ?? String(new TextEncoder().encode(encoded).byteLength);
  }
  return new NextRequest(`https://nailiq.test${pathname}`, {
    method: "POST",
    headers,
    body: encoded,
  });
}

describe("card-management capability authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => ({ data: { salon_id: "22222222-2222-4222-8222-222222222222" }, error: null })),
    };
    mocks.serviceRole.mockReturnValue({ from: vi.fn(() => builder) });
    mocks.looseFrom.mockReturnValue(builder);
    mocks.decision.mockResolvedValue({ required: true, feeCents: 2500 });
    mocks.save.mockResolvedValue({ ok: true });
    mocks.ensure.mockResolvedValue({ required: true });
    mocks.squareConfig.mockResolvedValue({
      applicationId: "sandbox-app", locationId: "sandbox-location", environment: "sandbox",
    });
    mocks.resolveProvider.mockResolvedValue({ kind: "stripe" });
    mocks.stripeCreate.mockResolvedValue({ client_secret: "seti_secret" });
    mocks.inspect.mockResolvedValue({ ok: false, code: "invalid_token" });
    mocks.managementRate.mockResolvedValue("allowed");
    mocks.cardSave.mockResolvedValue({ ok: true, code: "saved" });
    mocks.stripeSetup.mockResolvedValue({ ok: true, code: "setup_created" });
    mocks.exchange.mockResolvedValue({ ok: false, code: "create_binding_invalid" });
    mocks.overRate.mockResolvedValue(false);
  });

  it("rejects naked square config bookingId before service DB or provider configuration", async () => {
    const response = await squareConfigGet(new NextRequest(
      `https://nailiq.test/api/booking/square-noshow-config?bookingId=${BOOKING_ID}`,
    ));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.decision).not.toHaveBeenCalled();
    expect(mocks.serviceRole).not.toHaveBeenCalled();
    expect(mocks.squareConfig).not.toHaveBeenCalled();
  });

  it("rejects naked Square save before token persistence/provider work", async () => {
    const response = await squareSavePost(jsonRequest("/api/booking/square-save-card", {
      bookingId: BOOKING_ID,
      sourceId: "cnon:card-nonce-ok",
      consent: true,
    }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.cardSave).not.toHaveBeenCalled();
  });

  it("rejects naked Stripe setup before policy, DB, or provider work", async () => {
    const response = await stripeSetupPost(jsonRequest("/api/booking/stripe-setup-intent", {
      bookingId: BOOKING_ID,
    }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.decision).not.toHaveBeenCalled();
    expect(mocks.looseFrom).not.toHaveBeenCalled();
    expect(mocks.stripeCreate).not.toHaveBeenCalled();
  });

  it("rejects naked card-requirement mutation before DB state change", async () => {
    const response = await flagCardPost(jsonRequest("/api/booking/flag-noshow-card", {
      bookingId: BOOKING_ID,
    }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("card capability exchange rejects bookingId without the canonical create binding", async () => {
    const response = await cardCapabilityPost(jsonRequest("/api/booking/card-capability", {
      salonId: SALON_ID,
      bookingId: BOOKING_ID,
    }));
    expect(response.status).toBe(400);
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("wrong create receipt yields no capability and no policy/provider work", async () => {
    const response = await cardCapabilityPost(jsonRequest("/api/booking/card-capability", {
      salonId: SALON_ID,
      bookingId: BOOKING_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      pricingFingerprint: PRICING_FINGERPRINT,
    }));
    expect(response.status).toBe(404);
    expect(mocks.exchange).toHaveBeenCalledTimes(1);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.resolveProvider).not.toHaveBeenCalled();
  });

  it("exact create receipt returns only the trusted exchange token", async () => {
    mocks.exchange.mockResolvedValue({
      ok: true,
      capability: { tokenId: SALON_ID, action: "card_manage", scopeKind: "booking_own", epoch: 1, expiresAt: "2026-08-21T00:00:00.000Z", reused: false },
    });
    mocks.ensure.mockResolvedValue({ required: true });
    const response = await cardCapabilityPost(jsonRequest("/api/booking/card-capability", {
      salonId: SALON_ID,
      bookingId: BOOKING_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      pricingFingerprint: PRICING_FINGERPRINT,
    }, null));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, required: true, token: SALON_ID });
    expect(mocks.exchange).toHaveBeenCalledWith(expect.objectContaining({
      salonId: SALON_ID,
      bookingId: BOOKING_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      pricingFingerprint: PRICING_FINGERPRINT,
    }));
  });

  it("card exchange caps the actual stream before rate, DB, or policy", async () => {
    const response = await cardCapabilityPost(jsonRequest("/api/booking/card-capability", {
      salonId: SALON_ID,
      bookingId: BOOKING_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      pricingFingerprint: PRICING_FINGERPRINT,
      padding: "x".repeat(3000),
    }, "100"));
    expect(response.status).toBe(400);
    expect(mocks.overRate).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it.each([
    ["Square save", squareSavePost, "/api/booking/square-save-card", mocks.cardSave],
    ["Stripe setup", stripeSetupPost, "/api/booking/stripe-setup-intent", mocks.stripeSetup],
    ["requirement flag", flagCardPost, "/api/booking/flag-noshow-card", mocks.ensure],
  ] as const)("%s rejects an oversized actual stream with spoofed Content-Length before DB/provider", async (_label, handler, pathname, sideEffect) => {
    const response = await handler(jsonRequest(pathname, {
      // Include both the retired and replacement authorization fields so this
      // cannot pass merely because either implementation rejects a missing key.
      bookingId: BOOKING_ID,
      token: "22222222-2222-4222-8222-222222222222",
      requestId: "33333333-3333-4333-8333-333333333333",
      sourceId: "cnon:card-nonce-ok",
      provider: "square",
      consent: true,
      padding: "x".repeat(5000),
    }, "100"));
    expect(response.status).toBe(400);
    expect(mocks.managementRate).not.toHaveBeenCalled();
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it.each([
    ["Square save", squareSavePost, "/api/booking/square-save-card"],
    ["Stripe setup", stripeSetupPost, "/api/booking/stripe-setup-intent"],
    ["requirement flag", flagCardPost, "/api/booking/flag-noshow-card"],
  ] as const)("%s accepts a bounded body without Content-Length and reaches durable authorization", async (_label, handler, pathname) => {
    mocks.managementRate.mockResolvedValue("limited");
    const response = await handler(jsonRequest(pathname, {
      token: "22222222-2222-4222-8222-222222222222",
      requestId: "33333333-3333-4333-8333-333333333333",
      sourceId: "cnon:card-nonce-ok",
      provider: "square",
      consent: true,
    }, null));
    expect(response.status).toBe(429);
    expect(mocks.managementRate).toHaveBeenCalledTimes(1);
    expect(mocks.inspect).not.toHaveBeenCalled();
  });
});
