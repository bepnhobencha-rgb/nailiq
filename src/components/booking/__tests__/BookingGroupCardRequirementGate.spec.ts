import type { ComponentProps, ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[], effects: [] as Array<() => void> }));
const mocks = vi.hoisted(() => ({
  enabled: true,
  schedule: vi.fn(),
  requirement: vi.fn(),
  submit: vi.fn(),
}));

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  function memo<T>(factory: () => T, deps?: readonly unknown[]) {
    const index = hooks.cursor++;
    const previous = hooks.values[index] as { deps?: readonly unknown[]; value: T } | undefined;
    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
      hooks.values[index] = { deps, value: factory() };
    }
    return (hooks.values[index] as { value: T }).value;
  }
  return {
    ...actual,
    useMemo: memo,
    useCallback: <T,>(callback: T, deps: readonly unknown[]) => memo(() => callback, deps),
    useRef: <T,>(initial: T) => {
      const index = hooks.cursor++;
      return (hooks.values[index] ??= { current: initial }) as { current: T };
    },
    useState: <T,>(initial: T | (() => T)) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [hooks.values[index] as T, (next: T | ((current: T) => T)) => {
        hooks.values[index] = typeof next === "function" ? (next as (value: T) => T)(hooks.values[index] as T) : next;
      }] as const;
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.values[index] as { deps?: readonly unknown[]; cleanup?: () => void } | undefined;
      if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
        hooks.effects.push(() => {
          previous?.cleanup?.();
          hooks.values[index] = { deps, cleanup: effect() };
        });
      }
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/e2e-group-card-gate" }));
vi.mock("@/shared/release/v1IntegrationScope", () => ({ v1AllowsNoShowCardOnFile: () => mocks.enabled }));
vi.mock("@/shared/booking/loadGroupSmartSchedule", () => ({ loadGroupSmartSchedule: mocks.schedule }));
vi.mock("@/shared/booking/submitGroupBooking", () => ({ submitGroupBooking: mocks.submit }));
vi.mock("@/shared/booking/partyLinkActions", () => ({ createPartyLink: vi.fn() }));
vi.mock("@/shared/booking/checkGroupSlotsAvailable", () => ({ checkGroupSlotsAvailable: vi.fn(async () => ({ available: true })) }));
vi.mock("@/shared/noshow/resolveNoShowCardRequirement", () => ({ resolveNoShowCardRequirement: mocks.requirement }));
vi.mock("@/shared/noshow/resolveSavedNoShowCard", () => ({ resolveSavedNoShowCard: vi.fn() }));
vi.mock("@/shared/booking/submitCapacityRescueRequest", () => ({ submitCapacityRescueRequest: vi.fn() }));
vi.mock("@/shared/analytics/useBookingFunnelAnalytics", () => ({ useBookingFunnelAnalytics: vi.fn() }));
vi.mock("@/components/booking/BookingCalendarGrid", () => ({ BookingCalendarGrid: "mock-calendar" }));
vi.mock("@/components/booking/BookingFlowOtpPanel", () => ({ BookingFlowOtpPanel: "mock-otp" }));
vi.mock("@/components/booking/CapacityRescueOptIn", () => ({ CapacityRescueOptIn: "mock-rescue" }));
vi.mock("@/components/booking/ConfirmStepCardCapture", () => ({ ConfirmStepCardCapture: "mock-card" }));
vi.mock("@/components/booking/NoShowCardCapture", () => ({ NoShowCardCapture: "mock-saved-card" }));
vi.mock("@/components/booking/LuxuryBookingCta", () => ({ LuxuryBookingCta: "mock-cta" }));
vi.mock("@/components/ui/Button", () => ({ Button: "mock-button" }));

import { bookingEn } from "@/shared/i18n/booking/en";
import type { BookingSalonMeta } from "@/shared/booking/loadBookingServices";
import type { GroupBookingPricingRequest } from "@/shared/booking/groupBookingPricing";

type Node = ReactElement<Record<string, unknown>>;
type GroupComponent = typeof import("../BookingGroupFlow").BookingGroupFlow;
let Group: GroupComponent;
let props: ComponentProps<GroupComponent>;
const salonId = "11111111-1111-4111-8111-111111111111";
const serviceId = "22222222-2222-4222-8222-222222222222";
const staffIds = ["33333333-3333-4333-8333-333333333333", "33333333-3333-4333-8333-333333333334"];
const startTime = "2026-09-19T17:00:00.000Z";
const endTime = "2026-09-19T17:30:00.000Z";
const requirement = { required: true, provider: "square", feeCents: 2000, applicationId: "sandbox-app", locationId: "sandbox-location", environment: "sandbox" };

function nodes(value: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(value)) value.forEach((child) => nodes(child, out));
  else if (value && typeof value === "object" && "props" in value) {
    out.push(value as Node);
    nodes((value as Node).props.children, out);
  }
  return out;
}

function render() {
  hooks.cursor = 0;
  const tree = nodes(Group(props));
  hooks.effects.splice(0).forEach((effect) => effect());
  return tree;
}

function step(name: string) {
  const found = render().find((node) => typeof node.type === "function" && node.type.name === name);
  expect(found, `Expected wizard step ${name}`).toBeDefined();
  return found!;
}

function invoke(node: Node, handler: string, ...args: unknown[]) {
  return (node.props[handler] as (...values: unknown[]) => unknown)(...args);
}

async function settle() {
  for (let turn = 0; turn < 6; turn++) {
    await Promise.resolve();
    render();
  }
}

function rawQuote(request: GroupBookingPricingRequest, fingerprint = "a".repeat(64)) {
  const members = request.bookings.map((member, index) => ({
    member_index: index, service_id: member.serviceId, staff_id: member.staffId,
    start_time_utc: member.startTimeUtc, end_time_utc: member.endTimeUtc,
    addon_service_ids: [], addon_lines: [], first_addon_id: null, trailing_buffer_minutes: 0,
    promo_id: null, promo_name: null, original_price_cents: 5000, service_pre_voucher_cents: 5000,
    price_cents: 5000, addon_pre_voucher_cents: 0, addon_price_cents: 0,
    promo_discount_cents: 0, email_discount_cents: 0, voucher_discount_cents: 0,
    pre_voucher_subtotal_cents: 5000, subtotal_cents: 5000, tax_cents: 0,
    tax_amount_cents: 0, total_cents: 5000, tax_breakdown: [],
  }));
  return {
    success: true, code: "quoted", pricing_fingerprint: fingerprint, salon_id: request.salonId, group_size: members.length,
    currency: "CAD", voucher_id: null, voucher_code: null, original_price_cents: members.length * 5000,
    promo_discount_cents: 0, email_discount_cents: 0, voucher_discount_cents: 0,
    pre_voucher_subtotal_cents: members.length * 5000, subtotal_cents: members.length * 5000,
    tax_cents: 0, total_cents: members.length * 5000, tax_breakdown: [], member_quotes: members,
  };
}

function quoteResponse(request: GroupBookingPricingRequest, fingerprint?: string) {
  return { ok: true, json: async () => ({ ok: true, quote: rawQuote(request, fingerprint) }) };
}

async function reachArrangement() {
  invoke(step("SizeStep"), "onNext");
  invoke(step("ServiceStaffStep"), "onApplyServiceToAll", serviceId);
  invoke(step("ServiceStaffStep"), "onNext");
  invoke(step("DateArrivalStep"), "onDateChange", "2026-09-19");
  invoke(step("DateArrivalStep"), "onNext");
  await settle();
  step("ArrangementStep");
}

async function reachConfirm() {
  await reachArrangement();
  invoke(step("ArrangementStep"), "onNext");
  await settle();
  step("ConfirmStep");
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-12T17:00:00.000Z"));
  vi.stubGlobal("window", { setTimeout, clearTimeout, location: { search: "", origin: "http://localhost:3000" } });
  hooks.cursor = 0;
  hooks.values = [];
  hooks.effects = [];
  mocks.enabled = true;
  mocks.requirement.mockResolvedValue(requirement);
  mocks.submit.mockResolvedValue({ ok: false, reason: "otp_required" });
  mocks.schedule.mockResolvedValue({
    ok: true, timezone: "America/Vancouver", arrangements: [{
      kind: "best", groupStartMs: Date.parse(startTime), groupEndMs: Date.parse(endTime),
      groupStartDisplay: "10:00 AM", groupEndDisplay: "10:30 AM", summary: "Synthetic",
      assignments: staffIds.map((staffId, memberIndex) => ({
        memberIndex, serviceId, staffId, startUtcIso: startTime, endUtcIso: endTime, waveNumber: 1,
      })),
    }],
  });
  props = {
    t: bookingEn, shopSlug: "e2e-group-card-gate", maxGroupSize: 2,
    initialPhone: "+16045550191", initialName: "Synthetic Guest", initialSmsConsent: true,
    language: "en", addOns: [], staff: [],
    salon: {
      id: salonId, name: "E2E Group Card Gate", timezone: "America/Vancouver", currencyCode: "CAD",
      opening_hours: null, booking_closed_dates: null, emailLinksEnabled: true, salonPhone: "+16045550192",
    } as BookingSalonMeta,
    services: [{
      id: serviceId, name: "Synthetic Service", durationMinutes: 30, prepMinutes: 0,
      bufferMinutes: 0, totalMinutes: 30, priceCents: 5000, priceType: "fixed",
      priceMaxCents: null, priceDisplay: "$50.00", category: "other", description: null,
      isPopular: false, isFeatured: false, addonConcurrent: false, promoPriceCents: null,
      promoPriceDisplay: null, promoId: null, promoName: null,
    }],
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    expect(url).toBe("/api/booking/group-quote");
    return quoteResponse(JSON.parse(String(options.body)) as GroupBookingPricingRequest);
  }));
  Group = (await import("../BookingGroupFlow")).BookingGroupFlow;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("group card requirement release gate behavior", () => {
  it("quotes email guests without discount, then requires a new quote and explicit confirmation after SMS", async () => {
    await reachConfirm();
    invoke(step("ConfirmStep"), "onEmailChange", "synthetic@example.test");
    await settle();
    const requests = () => vi.mocked(fetch).mock.calls.map(([, options]) => JSON.parse(String(options?.body)) as GroupBookingPricingRequest);
    expect(requests().at(-1)?.applyEmailDiscount).toBe(false);
    const choice = () => step("BookingPhoneDiscountChoice");
    invoke(choice(), "onStart");
    expect(render().some((node) => typeof node.type === "function" && node.type.name === "ConfirmStep")).toBe(false);
    invoke(choice(), "onVerified", "55555555-5555-4555-8555-555555555555");
    await settle();
    expect(requests().at(-1)).toMatchObject({ applyEmailDiscount: true, otpSessionId: "55555555-5555-4555-8555-555555555555" });
    expect(mocks.requirement.mock.lastCall?.[0]).toMatchObject({ groupIntent: {
      applyEmailDiscount: true, otpSessionId: "55555555-5555-4555-8555-555555555555",
    } });
    expect(step("ConfirmStep").props.noShowConsent).toBe(false);
    expect(mocks.submit).not.toHaveBeenCalled();
    invoke(choice(), "onSkip");
    await settle();
    expect(requests().at(-1)?.applyEmailDiscount).toBe(false);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("does not resolve card requirements before confirmation", async () => {
    await reachArrangement();
    expect(mocks.requirement).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("offers SMS recovery after a personalized voucher denial without silently applying another price", async () => {
    await reachConfirm();
    const previousQuote = step("ConfirmStep").props.pricingQuote;
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ ok: false, code: "phone_verification_required" }) } as Response);
    expect(await invoke(step("ConfirmStep"), "onApplyVoucher", "PERSONAL", 10000)).toEqual({ error: "phone_verification_required" });
    expect(step("BookingPhoneDiscountChoice").props.verificationRequired).toBe(true);
    expect(step("ConfirmStep").props.pricingQuote).toEqual(previousQuote);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("does not resolve card requirements when the V1 card flag is off, even with a valid quote", async () => {
    mocks.enabled = false;
    vi.resetModules();
    Group = (await import("../BookingGroupFlow")).BookingGroupFlow;
    await reachConfirm();
    expect(step("ConfirmStep").props.pricingQuote).not.toBeNull();
    expect(mocks.requirement).not.toHaveBeenCalled();
    expect(step("ConfirmStep").props.cardRequirement).toBeNull();
  });

  it("does not resolve or submit while the authoritative quote is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    await reachConfirm();
    expect(mocks.requirement).not.toHaveBeenCalled();
    expect(step("ConfirmStep").props.pricingQuote).toBeNull();
    invoke(step("ConfirmStep"), "onSubmit");
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("rejects a structurally valid quote for another service", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      const request = JSON.parse(String(options.body)) as GroupBookingPricingRequest;
      const quote = rawQuote(request);
      quote.member_quotes[0].service_id = "22222222-2222-4222-8222-222222222229";
      return { ok: true, json: async () => ({ ok: true, quote }) };
    }));
    await reachConfirm();
    expect(step("ConfirmStep").props.pricingQuote).toBeNull();
    expect(mocks.requirement).not.toHaveBeenCalled();
  });

  it("resolves using the accepted full group intent and exact pricing fingerprint", async () => {
    await reachConfirm();
    expect(mocks.requirement).toHaveBeenCalledTimes(1);
    expect(mocks.requirement).toHaveBeenCalledWith(expect.objectContaining({
      salonId, serviceId, clientPhone: "16045550191", groupPricingFingerprint: "a".repeat(64),
      groupIntent: expect.objectContaining({ salonId, bookings: expect.arrayContaining([
        expect.objectContaining({ serviceId, staffId: staffIds[0], startTimeUtc: startTime }),
        expect.objectContaining({ serviceId, staffId: staffIds[1], startTimeUtc: startTime }),
      ]) }),
    }));
    expect(step("ConfirmStep").props.cardRequirement).toEqual(requirement);
    expect(step("ConfirmStep").props.cardRequirementLoading).toBe(false);
  });

  it("invalidates an old quote immediately when organizer contact changes", async () => {
    await reachConfirm();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    invoke(step("ConfirmStep"), "onEmailChange", "changed@example.test");
    expect(step("ConfirmStep").props.pricingQuote).toBeNull();
    expect(step("ConfirmStep").props.cardRequirement).toBeNull();
    invoke(step("ConfirmStep"), "onSubmit");
    expect(mocks.requirement).toHaveBeenCalledTimes(1);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("ignores an obsolete quote that arrives after the new intent has been priced", async () => {
    let oldRequest!: GroupBookingPricingRequest;
    let finishOld!: (value: ReturnType<typeof quoteResponse>) => void;
    const delayed = new Promise<ReturnType<typeof quoteResponse>>((resolve) => { finishOld = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      const request = JSON.parse(String(options.body)) as GroupBookingPricingRequest;
      if (!request.bookings[0].clientEmail) {
        oldRequest = request;
        return delayed;
      }
      return quoteResponse(request, "b".repeat(64));
    }));
    await reachConfirm();
    expect(mocks.requirement).not.toHaveBeenCalled();
    invoke(step("ConfirmStep"), "onEmailChange", "changed@example.test");
    await settle();
    expect(mocks.requirement).toHaveBeenCalledTimes(1);
    expect(mocks.requirement.mock.calls[0][0].groupPricingFingerprint).toBe("b".repeat(64));
    finishOld(quoteResponse(oldRequest));
    await settle();
    expect(mocks.requirement).toHaveBeenCalledTimes(1);
    expect((step("ConfirmStep").props.pricingQuote as { pricingFingerprint: string }).pricingFingerprint).toBe("b".repeat(64));
  });

  it("re-collects consent and token after an intent change, and wires group email/call OTP recovery", async () => {
    await reachConfirm();
    const tokenize = vi.fn()
      .mockResolvedValueOnce({ token: "synthetic-source-1", verificationToken: "synthetic-verification-1" })
      .mockResolvedValueOnce({ token: "synthetic-source-2", verificationToken: "synthetic-verification-2" });
    (step("ConfirmStep").props.cardRef as { current: unknown }).current = { tokenize };
    invoke(step("ConfirmStep"), "onNoShowConsentChange", true);
    invoke(step("ConfirmStep"), "onSubmit");
    await settle();
    const otp = render().find((node) => (node.type as unknown) === "mock-otp")!;
    expect(otp).toBeDefined();
    expect(otp.props.emailChannelEnabled).toBe(true);
    expect(otp.props.salonPhone).toBe(props.salon.salonPhone);
    invoke(otp, "onBack");
    invoke(step("ConfirmStep"), "onEmailChange", "changed@example.test");
    await settle();
    expect(step("ConfirmStep").props.noShowConsent).toBe(false);
    expect(mocks.requirement).toHaveBeenCalledTimes(2);
    invoke(step("ConfirmStep"), "onSubmit");
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    invoke(step("ConfirmStep"), "onNoShowConsentChange", true);
    invoke(step("ConfirmStep"), "onSubmit");
    await settle();
    expect(tokenize).toHaveBeenCalledTimes(2);
    expect(mocks.submit.mock.calls.map(([request]) => request.noShowCardSourceId)).toEqual(["synthetic-source-1", "synthetic-source-2"]);
    expect(mocks.submit.mock.calls.map(([request]) => request.noShowCardVerificationToken)).toEqual(["synthetic-verification-1", "synthetic-verification-2"]);
    const secondOtp = render().find((node) => (node.type as unknown) === "mock-otp")!;
    expect(secondOtp.props.clientEmail).toBe("changed@example.test");
  });
});
