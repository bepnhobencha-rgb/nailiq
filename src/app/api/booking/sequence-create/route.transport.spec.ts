import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  replay: vi.fn(), create: vi.fn(), exchange: vi.fn(), inspect: vi.fn(),
  requirement: vi.fn(), pending: vi.fn(), resolve: vi.fn(), save: vi.fn(),
  overRate: vi.fn(), mutationRate: vi.fn(), network: vi.fn(), after: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => ({
  ...await original<typeof import("next/server")>(), after: m.after,
}));
vi.mock("@/shared/booking/bookingSequenceServer", async (original) => ({
  ...await original<typeof import("@/shared/booking/bookingSequenceServer")>(),
  replayPublicBookingSequence: m.replay, createPublicBookingSequence: m.create,
}));
vi.mock("@/shared/booking/bookingSequenceReadiness", () => ({
  loadPublicBookingSequenceReadiness: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    rpc: vi.fn(async () => ({ data: true, error: null })),
    from: () => ({ select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: { phone_otp_enabled: false }, error: null }),
    }) }) }),
  }),
}));
vi.mock("@/shared/booking/bookingManagementCapabilities", () => ({
  exchangePublicBookingCardManagementCapability: m.exchange,
  inspectBookingManagementCapability: m.inspect,
}));
vi.mock("@/shared/noshow/ensureNoShowCardRequirement", () => ({ ensureNoShowCardRequirement: m.requirement }));
vi.mock("@/shared/booking/bookingCardContinuation", () => ({
  recordCommittedBookingCardPending: m.pending, resolveCommittedBookingCardContinuation: m.resolve,
}));
vi.mock("@/shared/booking/bookingCardManagement", () => ({ saveCardWithManagementCapability: m.save }));
vi.mock("@/shared/booking/bookingManagementRateLimit", () => ({ consumeBookingManagementRateLimit: m.mutationRate }));
vi.mock("@/shared/lib/inAppRateLimit", async (original) => ({
  ...await original<typeof import("@/shared/lib/inAppRateLimit")>(), isOverRateLimit: m.overRate,
}));
vi.mock("@/shared/booking/sendBookingConfirmationEmail", () => ({ sendBookingConfirmationEmail: vi.fn() }));

import { POST } from "./route";
import { durableRateLimitKey } from "@/shared/lib/inAppRateLimit";
import { createCommittedBookingCardServerTransport } from "@/shared/booking/bookingCardManagementServer";
import { POST as capabilityPost } from "@/app/api/booking/card-capability/route";
import { POST as savePost } from "@/app/api/booking/square-save-card/route";

const origin = "https://isolated-sequence-preview.vercel.app";
const ids = {
  salon: "11111111-1111-4111-8111-111111111111",
  request: "22222222-2222-4222-8222-222222222222",
  line: "33333333-3333-4333-8333-333333333333",
  service: "44444444-4444-4444-8444-444444444444",
  booking: "55555555-5555-4555-8555-555555555555",
  capability: "66666666-6666-4666-8666-666666666666",
};
const fingerprint = "a".repeat(64);
const committed = {
  ok: true, bookingId: ids.booking, segmentIds: [], idempotent: true,
  quote: { lines: [], pricingFingerprint: fingerprint },
  salonSlug: "qa-sequence", smsConsent: false, language: "en",
};
function request(card = false) {
  return new Request(`${origin}/api/booking/sequence-create`, {
    method: "POST", headers: {
      origin, "content-type": "application/json", "x-forwarded-for": "192.0.2.15, 192.0.2.16",
      cookie: "preview-session=must-stay-local", authorization: "Bearer must-stay-local",
    },
    body: JSON.stringify({
      intent: {
        salonId: ids.salon, requestId: ids.request, requestedStartTimeUtc: "2026-09-15T17:00:00Z",
        lines: [{ lineId: ids.line, position: 0, serviceId: ids.service,
          staffPreference: "any", preferredResourceId: null, addOnServiceIds: [] }],
        sameStaffForAll: false, voucherCode: null, applyEmailDiscount: false,
        customer: { name: "QA Sequence", phone: "+16045550123", email: null },
      },
      expectedPricingFingerprint: fingerprint, otpSessionId: null,
      healthAcknowledged: true, smsConsent: false, language: "en",
      ...(card ? { cardSourceId: "synthetic-source", noShowConsent: true } : {}),
    }),
  });
}
async function submit(card = false) {
  const response = await POST(request(card) as never);
  expect(response.status).toBe(200);
  const value = await response.json();
  expect(value.bookingId).toBe(ids.booking);
  expect(value.quote).toEqual(committed.quote);
  expect(m.create).not.toHaveBeenCalled();
  return value;
}

describe("sequence post-commit card settlement without a protected HTTP self-fetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.replay.mockResolvedValue(committed);
    m.exchange.mockResolvedValue({ ok: true, capability: { scopeKind: "booking_own", tokenId: ids.capability } });
    m.requirement.mockResolvedValue({ required: false, feeCents: 0 });
    m.resolve.mockResolvedValue(true);
    m.overRate.mockResolvedValue(false);
    m.mutationRate.mockResolvedValue("allowed");
    m.save.mockResolvedValue({ ok: true, code: "saved" });
    m.after.mockImplementation(() => undefined);
    m.network.mockResolvedValue(new Response("Preview authentication required", { status: 401 }));
    vi.stubGlobal("fetch", m.network);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("resolves a no-card sequence on an SSO-protected Preview without network or SMS proof", async () => {
    const value = await submit();
    expect(value.cardManagementPending).toBe(false);
    expect(value.cardManagementToken).toBeNull();
    expect(value.cardManagementRecoveryHref).toBeNull();
    expect(m.network).not.toHaveBeenCalled();
    expect(m.exchange).toHaveBeenCalledWith({ salonId: ids.salon, bookingId: ids.booking,
      idempotencyKey: ids.request, pricingFingerprint: fingerprint });
    expect(m.requirement).toHaveBeenCalledWith(ids.booking, { strict: true });
    expect(m.overRate).toHaveBeenCalledWith(
      durableRateLimitKey("card-capability-exchange", "192.0.2.15", ids.salon), 12, 300, { failureMode: "block" },
    );
    expect(m.save).not.toHaveBeenCalled();
  });

  it("never saves a held source when the exact receipt resolves as not required", async () => {
    expect((await submit(true)).cardManagementPending).toBe(false);
    expect(m.save).not.toHaveBeenCalled();
    expect(m.network).not.toHaveBeenCalled();
  });

  it("also settles the first committed no-card create without repeating the booking", async () => {
    m.replay.mockResolvedValue({ ok: false, code: "replay_not_found" });
    m.create.mockResolvedValue({ ...committed, idempotent: false });
    const response = await POST(request() as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true, bookingId: ids.booking, cardManagementPending: false,
      cardManagementToken: null, cardManagementRecoveryHref: null,
    });
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ otpSessionId: null }));
    expect(m.create.mock.invocationCallOrder[0]).toBeLessThan(m.exchange.mock.invocationCallOrder[0]);
    expect(m.network).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
  });

  it("saves a required card once with the original request identity and isolated headers", async () => {
    m.requirement.mockResolvedValue({ required: true, feeCents: 1000 });
    const value = await submit(true);
    expect(value.cardManagementPending).toBe(false);
    expect(m.save).toHaveBeenCalledExactlyOnceWith({
      tokenId: ids.capability, requestId: ids.request, provider: "square",
      sourceToken: "synthetic-source", verificationToken: undefined,
    });
    const rateRequest = m.mutationRate.mock.calls[0][0].request as Request;
    expect(rateRequest.headers.get("x-forwarded-for")).toBe("192.0.2.15");
    expect(rateRequest.headers.get("cookie")).toBeNull();
    expect(rateRequest.headers.get("authorization")).toBeNull();
    expect(rateRequest.headers.get("x-vercel-protection-bypass")).toBeNull();
    expect(m.network).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, code: "save_failed", failureKind: "card_rejected" },
    { ok: false, code: "save_unknown" },
    { ok: false, code: "reconciliation_required" },
  ])("keeps the canonical booking pending without redispatch after $code", async (result) => {
    m.requirement.mockResolvedValue({ required: true, feeCents: 1000 });
    m.save.mockResolvedValue(result);
    const value = await submit(true);
    expect(value.cardManagementPending).toBe(true);
    expect(value.cardManagementToken).toBe(ids.capability);
    expect(m.save).toHaveBeenCalledTimes(1);
    expect(m.network).not.toHaveBeenCalled();
    expect(JSON.stringify(value)).not.toContain("synthetic-source");
  });

  it("cannot assess or save a card from a rejected create binding", async () => {
    m.exchange.mockResolvedValue({ ok: false, code: "create_binding_invalid" });
    const value = await submit(true);
    expect(value.cardManagementPending).toBe(true);
    expect(value.cardManagementToken).toBeNull();
    expect(m.requirement).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
  });

  it("does not treat an unavailable policy assessment as no card required", async () => {
    m.requirement.mockRejectedValue(new Error("synthetic policy timeout"));
    expect((await submit()).cardManagementPending).toBe(true);
    expect(m.pending).toHaveBeenCalledWith(expect.objectContaining({ stage: "assessment" }));
    expect(m.resolve).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
  });

  it("retains both durable rate limits before exchange and provider work", async () => {
    m.overRate.mockResolvedValue(true);
    expect((await submit(true)).cardManagementPending).toBe(true);
    expect(m.exchange).not.toHaveBeenCalled();
    m.overRate.mockResolvedValue(false);
    m.requirement.mockResolvedValue({ required: true, feeCents: 1000 });
    m.mutationRate.mockResolvedValue("unavailable");
    expect((await submit(true)).cardManagementPending).toBe(true);
    expect(m.save).not.toHaveBeenCalled();
  });

  it("never advances to save after an exchange returns beyond the five-second deadline", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    m.exchange.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const result = submit(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await result).cardManagementPending).toBe(true);
    finish({ ok: true, capability: { scopeKind: "booking_own", tokenId: ids.capability } });
    await vi.advanceTimersByTimeAsync(1);
    expect(m.requirement).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
  });

  it("does not dispatch after the save limiter finishes beyond the deadline", async () => {
    vi.useFakeTimers();
    m.requirement.mockResolvedValue({ required: true, feeCents: 1000 });
    let finish!: (value: string) => void;
    m.mutationRate.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const result = submit(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await result).cardManagementPending).toBe(true);
    finish("allowed");
    await vi.advanceTimersByTimeAsync(1);
    expect(m.save).not.toHaveBeenCalled();
  });

  it("does not redispatch when an already-started save returns after the deadline", async () => {
    vi.useFakeTimers();
    m.requirement.mockResolvedValue({ required: true, feeCents: 1000 });
    let finish!: (value: unknown) => void;
    m.save.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const result = submit(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await result).cardManagementPending).toBe(true);
    finish({ ok: true, code: "saved" });
    await vi.advanceTimersByTimeAsync(1);
    expect(m.save).toHaveBeenCalledTimes(1);
    expect(m.network).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("keeps the same late save alive until it settles (%s), without replay or raw error logging", async (outcome) => {
    vi.useFakeTimers();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      m.requirement.mockResolvedValue({ required: true, feeCents: 1000 });
      let finish!: (value: unknown) => void;
      let reject!: (reason: unknown) => void;
      m.save.mockImplementation(() => new Promise((resolve, fail) => { finish = resolve; reject = fail; }));
      const response = submit(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect((await response).cardManagementPending).toBe(true);
      // Capability and save lifecycle callbacks precede the existing SMS task.
      expect(m.after).toHaveBeenCalledTimes(3);
      const keepAlive = m.after.mock.calls[1][0] as () => Promise<void>;
      let drained = false;
      const background = keepAlive().then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(1);
      expect(drained).toBe(false);
      if (outcome === "resolve") finish({ ok: true, code: "saved" });
      else reject(new Error("synthetic-private-provider-error"));
      await background;
      expect(drained).toBe(true);
      expect(m.save).toHaveBeenCalledTimes(1);
      expect(m.network).not.toHaveBeenCalled();
      expect(errorLog).not.toHaveBeenCalled();
    } finally { errorLog.mockRestore(); }
  });

  it("does not enter a handler if the platform cannot register its lifetime", async () => {
    m.after.mockImplementationOnce(() => { throw new Error("synthetic_wait_until_unavailable"); });
    expect((await submit(true)).cardManagementPending).toBe(true);
    expect(m.overRate).not.toHaveBeenCalled();
    expect(m.exchange).not.toHaveBeenCalled();
    expect(m.requirement).not.toHaveBeenCalled();
    expect(m.mutationRate).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
  });

  it.each([
    "/api/booking/card-capability?other=1", "/api/booking/remove-card",
    "https://outside.invalid/api/booking/square-save-card",
    `${origin}/api/booking/card-capability`,
  ])("rejects an unrecognized internal target without network fallback: %s", async (target) => {
    const transport = createCommittedBookingCardServerTransport(request());
    await expect(transport(target, { method: "POST", body: "{}" })).rejects.toThrow("invalid_card_management_transport");
    expect(m.exchange).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
    expect(m.network).not.toHaveBeenCalled();
  });

  it("rejects non-POST, non-string bodies and already-aborted internal work", async () => {
    const transport = createCommittedBookingCardServerTransport(request());
    for (const init of [{ method: "GET", body: "{}" }, { method: "POST", body: new URLSearchParams() }]) {
      await expect(transport("/api/booking/card-capability", init)).rejects.toThrow("invalid_card_management_transport");
    }
    const controller = new AbortController();
    controller.abort();
    await expect(transport("/api/booking/square-save-card", {
      method: "POST", body: "{}", signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(m.exchange).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
  });

  it.each([
    ["/api/booking/card-capability", capabilityPost],
    ["/api/booking/square-save-card", savePost],
  ] as const)("retains public origin, bounded body and private response guards: %s", async (path, handler) => {
    const wrongOrigin = new Request(origin + path, { method: "POST",
      headers: { origin: "https://outside.invalid", "content-type": "application/json" }, body: "{}" });
    expect((await handler(wrongOrigin)).status).toBe(403);
    const oversized = new Request(origin + path, { method: "POST",
      headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(5000) }) });
    const response = await handler(oversized);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(m.exchange).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
  });
});
