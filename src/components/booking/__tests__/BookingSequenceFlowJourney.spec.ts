import type { ReactElement } from "react";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CardRequirementResult =
  | { required: false }
  | {
      required: true;
      feeCents: number;
      provider: "square";
      applicationId: string;
      locationId: string;
      environment: "production" | "sandbox";
    };
type SavedCardResult =
  | { hasSavedCard: false }
  | { hasSavedCard: true; brand: string; last4: string };

const navigation = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const hookState = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[] }));
const cardRequirement = vi.hoisted(() =>
  vi.fn<() => Promise<CardRequirementResult>>(async () => ({ required: false })),
);
const savedCard = vi.hoisted(() =>
  vi.fn<() => Promise<SavedCardResult>>(async () => ({ hasSavedCard: false })),
);

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = hookState.cursor++;
      const previous = hookState.values[index] as { deps?: readonly unknown[]; cleanup?: () => void } | undefined;
      if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
        previous?.cleanup?.();
        hookState.values[index] = { deps, cleanup: effect() };
      }
    },
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: <T,>(initial: T) => {
      const index = hookState.cursor;
      hookState.cursor += 1;
      if (!(index in hookState.values)) hookState.values[index] = { current: initial };
      return hookState.values[index] as { current: T };
    },
    useState: <T,>(initial: T | (() => T)) => {
      const index = hookState.cursor;
      hookState.cursor += 1;
      if (!(index in hookState.values)) {
        hookState.values[index] = typeof initial === "function"
          ? (initial as () => T)()
          : initial;
      }
      const setValue = (next: T | ((current: T) => T)) => {
        const current = hookState.values[index] as T;
        hookState.values[index] = typeof next === "function"
          ? (next as (value: T) => T)(current)
          : next;
      };
      return [hookState.values[index] as T, setValue] as const;
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));

vi.mock("@/shared/lib/salonTime", () => ({
  salonToday: () => "2026-08-21",
  salonWallTimeToUtcIso: () => "2026-08-28T18:00:00.000Z",
}));
vi.mock("@/shared/lib/currencyFormat", () => ({
  formatCurrency: (cents: number, currency: string) => `${currency}:${cents}`,
}));
vi.mock("@/shared/noshow/resolveNoShowCardRequirement", () => ({
  resolveNoShowCardRequirement: cardRequirement,
}));
vi.mock("@/shared/noshow/resolveSavedNoShowCard", () => ({
  resolveSavedNoShowCard: savedCard,
}));
vi.mock("@/components/booking/ConfirmStepCardCapture", () => ({
  ConfirmStepCardCapture: () => null,
}));

import type { BookingSequenceQuote } from "@/shared/booking/bookingSequenceServer";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import type {
  BookingSalonMeta,
  BookingStaffItem,
} from "@/shared/booking/loadBookingServices";
import { bookingEn } from "@/shared/i18n/booking/en";

type ElementNode = ReactElement<Record<string, unknown>>;
let BookingSequenceFlow: typeof import("../BookingSequenceFlow").BookingSequenceFlow;

const salonId = "11111111-1111-4111-8111-111111111111";
const serviceId = "22222222-2222-4222-8222-222222222222";
const secondServiceId = "22222222-2222-4222-8222-222222222223";
const staffId = "33333333-3333-4333-8333-333333333333";

function quote(label: string, fingerprint: string, totalCents: number) {
  return {
    pricingFingerprint: fingerprint,
    currency: "CAD",
    originalPriceCents: totalCents,
    promoDiscountCents: 0,
    emailDiscountCents: 0,
    voucherDiscountCents: 0,
    subtotalCents: totalCents,
    taxBreakdown: [],
    totalCents,
    lines: [
      {
        lineId: "44444444-4444-4444-8444-444444444444",
        position: 0,
        serviceId,
        serviceName: `${label} A`,
        staffName: "Mai",
        serviceStartUtc: "2026-08-28T18:00:00.000Z",
        serviceEndUtc: "2026-08-28T18:30:00.000Z",
        prepMinutes: 10,
        durationMinutes: 30,
        bufferMinutes: 5,
        addonLines: [],
        promoDiscountCents: 0,
        emailDiscountCents: 0,
        voucherDiscountCents: 0,
        taxBreakdown: [],
        totalCents: totalCents - 1_000,
      },
      {
        lineId: "44444444-4444-4444-8444-444444444445",
        position: 1,
        serviceId: secondServiceId,
        serviceName: `${label} B`,
        staffName: "Mai",
        serviceStartUtc: "2026-08-28T18:45:00.000Z",
        serviceEndUtc: "2026-08-28T19:05:00.000Z",
        prepMinutes: 5,
        durationMinutes: 20,
        bufferMinutes: 0,
        addonLines: [],
        promoDiscountCents: 0,
        emailDiscountCents: 0,
        voucherDiscountCents: 0,
        taxBreakdown: [],
        totalCents: 1_000,
      },
    ],
  } as unknown as BookingSequenceQuote;
}

function response(ok: boolean, body: Record<string, unknown>) {
  return { ok, status: ok ? 200 : 409, json: async () => {
    const request = JSON.parse(String(vi.mocked(fetch).mock.lastCall?.[1]?.body));
    return { ...body,
      ...(ok && !("bookingId" in body) ? { bookingId: "66666666-6666-4666-8666-666666666666" } : {}),
      ...(body.quote ? { quote: { salonId, requestId: (request.intent ?? request).requestId, ...body.quote as object } } : {}),
    };
  } } as Response;
}

function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object" && "props" in value) {
    return text((value as ElementNode).props.children);
  }
  return "";
}

function elements(value: unknown, found: ElementNode[] = []): ElementNode[] {
  if (Array.isArray(value)) {
    value.forEach((item) => elements(item, found));
  } else if (value && typeof value === "object" && "props" in value) {
    const node = value as ElementNode;
    found.push(node);
    elements(node.props.children, found);
  }
  return found;
}

function renderFlow(overrides: Partial<Parameters<typeof BookingSequenceFlow>[0]> = {}) {
  hookState.cursor = 0;
  return BookingSequenceFlow({
    t: bookingEn,
    services: [
      { id: serviceId, name: "Gel" },
      { id: secondServiceId, name: "Art" },
    ] as BookingServiceItem[],
    addOns: [],
    staff: [{ id: staffId, name: "Mai" }] as BookingStaffItem[],
    capabilityRows: [
      { staff_id: staffId, service_id: serviceId },
      { staff_id: staffId, service_id: secondServiceId },
    ],
    salon: {
      id: salonId,
      timezone: "America/Vancouver",
    } as BookingSalonMeta,
    language: "en",
    customer: { name: "Lan", phone: "+16045550123", email: "lan@example.com" },
    otpSessionId: "55555555-5555-4555-8555-555555555555",
    initialSmsConsent: true,
    ...overrides,
  });
}

function prepareIntent() {
  let tree = renderFlow();
  const select = elements(tree).find((node) => node.type === "select");
  (select?.props.onChange as (event: unknown) => void)({ target: { value: serviceId } });
  tree = renderFlow();
  click(tree, "Add service");
  tree = renderFlow();
  const secondService = elements(tree).find(
    (node) => node.type === "select" && node.props.value === "",
  );
  (secondService?.props.onChange as (event: unknown) => void)({
    target: { value: secondServiceId },
  });
  tree = renderFlow();
  const date = elements(tree).find(
    (node) => node.type === "input" && node.props.type === "date",
  );
  (date?.props.onChange as (event: unknown) => void)({ target: { value: "2026-08-28" } });
  tree = renderFlow();
  const time = elements(tree).find(
    (node) => node.type === "input" && node.props.type === "time",
  );
  (time?.props.onChange as (event: unknown) => void)({ target: { value: "11:00" } });
  tree = renderFlow();
  const termsLabel = elements(tree).find(
    (node) => node.type === "label" && text(node.props.children).includes("I agree"),
  );
  const terms = elements(termsLabel).find(
    (node) => node.type === "input" && node.props.type === "checkbox",
  );
  (terms?.props.onChange as (event: unknown) => void)({ target: { checked: true } });
  return renderFlow();
}

function click(tree: ElementNode, label: string) {
  const button = elements(tree).find(
    (node) => node.type === "button" && text(node.props.children).includes(label),
  );
  expect(button, `button ${label}`).toBeDefined();
  (button?.props.onClick as () => void)();
}

describe("BookingSequenceFlow authoritative journey", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(async () => {
    hookState.cursor = 0;
    hookState.values = [];
    vi.restoreAllMocks();
    navigation.replace.mockReset();
    vi.resetModules();
    cardRequirement.mockResolvedValue({ required: false });
    savedCard.mockResolvedValue({ hasSavedCard: false });
    ({ BookingSequenceFlow } = await import("../BookingSequenceFlow"));
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    };
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("window", { sessionStorage: storage });
  });

  it("labels the start date and time controls for customers and assistive technology", () => {
    const tree = renderFlow();
    const nodes = elements(tree);
    const dateInput = nodes.find(
      (node) => node.type === "input" && node.props.type === "date",
    );
    const timeInput = nodes.find(
      (node) => node.type === "input" && node.props.type === "time",
    );
    const dateLabel = nodes.find(
      (node) => node.type === "label" && text(node.props.children).includes("Start date"),
    );
    const timeLabel = nodes.find(
      (node) => node.type === "label" && text(node.props.children).includes("Start time"),
    );

    expect(dateInput?.props.id).toBe("booking-sequence-date");
    expect(timeInput?.props.id).toBe("booking-sequence-time");
    expect(dateLabel?.props.htmlFor).toBe("booking-sequence-date");
    expect(timeLabel?.props.htmlFor).toBe("booking-sequence-time");
  });

  it("keeps the no-discount default and requotes after SMS without auto-submitting", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(true, { ok: true, quote: quote("Offer quote", "a".repeat(64), 5_000) }));
    vi.stubGlobal("fetch", fetchMock);
    const tree = prepareIntent();
    click(tree, "Review sequence");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ applyEmailDiscount: false });
    await vi.waitFor(() => expect(text(renderFlow())).toContain("Confirm sequence"));
    const choice = () => elements(renderFlow({ shopSlug: "synthetic-salon" })).find((node) => typeof node.type === "function" && node.type.name === "BookingPhoneDiscountChoice")!;
    (choice().props.onStart as () => void)();
    expect(elements(renderFlow()).some((node) => node.type === "button" && text(node.props.children).includes("Confirm sequence"))).toBe(false);
    (choice().props.onVerified as (session: string) => void)("66666666-6666-4666-8666-666666666666");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    click(renderFlow(), "Review sequence");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ applyEmailDiscount: true, otpSessionId: "66666666-6666-4666-8666-666666666666" });
    expect(fetchMock.mock.calls.every(([url]) => url === "/api/booking/sequence-quote")).toBe(true);
    await vi.waitFor(() => expect(text(renderFlow())).toContain("Confirm sequence"));
    (choice().props.onSkip as () => void)();
    click(renderFlow(), "Review sequence");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({ applyEmailDiscount: false });
  });

  it("phone_verification_required removes the old quote and offers SMS or no discount", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ ok: false, code: "phone_verification_required" }) });
    vi.stubGlobal("fetch", fetchMock);
    click(prepareIntent(), "Review sequence");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(text(renderFlow())).toContain(bookingEn.phoneOfferVerificationRequired));
    const tree = renderFlow({ shopSlug: "synthetic-salon" });
    const choice = elements(tree).find((node) => typeof node.type === "function" && node.type.name === "BookingPhoneDiscountChoice");
    expect(choice?.props.verificationRequired).toBe(true);
    expect(text(tree)).toContain(bookingEn.phoneOfferVerificationRequired);
    expect(elements(tree).some((node) => node.type === "button" && text(node.props.children).includes("Confirm sequence"))).toBe(false);
  });

  it("keeps one intent through pricing_changed and requires an explicit reconfirm", async () => {
    const quoted = quote("Initial quote", "a".repeat(64), 5_000);
    const changed = quote("Updated quote", "b".repeat(64), 5_500);
    const persisted = quote("Persisted create", "b".repeat(64), 5_500);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(true, { ok: true, quote: quoted }))
      .mockResolvedValueOnce(response(false, { ok: false, code: "pricing_changed", quote: changed }))
      .mockResolvedValueOnce(response(true, { ok: true, quote: persisted }));
    vi.stubGlobal("fetch", fetchMock);

    let tree = prepareIntent();
    click(tree, "Review sequence");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => {
      tree = renderFlow();
      expect(text(tree)).toContain("Confirm sequence");
      const confirm = elements(tree).find(
        (node) => node.type === "button" && text(node.props.children).includes("Confirm sequence"),
      );
      expect(confirm?.props.disabled).toBe(false);
    });
    click(tree, "Confirm sequence");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      tree = renderFlow();
      expect(text(tree)).toContain("Price or timing changed");
      expect(text(tree)).toContain("Confirm updated price");
      const confirm = elements(tree).find(
        (node) => node.type === "button" && text(node.props.children).includes("Confirm updated price"),
      );
      expect(confirm?.props.disabled).toBe(false);
    });
    click(tree, "Confirm updated price");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => {
      expect(elements(renderFlow()).some(
        (node) => node.props["data-testid"] === "booking-sequence-done",
      )).toBe(true);
    });

    const firstCreate = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      intent: { requestId: string };
      expectedPricingFingerprint: string;
      healthAcknowledged: boolean;
      smsConsent: boolean;
      language: string;
    };
    const retryCreate = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as {
      intent: { requestId: string };
      expectedPricingFingerprint: string;
    };
    expect(retryCreate.intent.requestId).toBe(firstCreate.intent.requestId);
    expect(firstCreate.intent).toMatchObject({
      lines: [
        { position: 0, serviceId },
        { position: 1, serviceId: secondServiceId },
      ],
    });
    expect(firstCreate.expectedPricingFingerprint).toBe("a".repeat(64));
    expect(firstCreate).toMatchObject({
      healthAcknowledged: false,
      smsConsent: true,
      language: "en",
    });
    expect(retryCreate.expectedPricingFingerprint).toBe("b".repeat(64));
    expect(elements(renderFlow()).some(
      (node) => node.props["data-testid"] === "booking-sequence-done",
    )).toBe(true);
  });

  it("renders Done from the authoritative create receipt, not the earlier quote", async () => {
    const quoted = quote("Earlier quote", "a".repeat(64), 5_000);
    const persisted = quote("Persisted create receipt", "a".repeat(64), 5_000);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(true, { ok: true, quote: quoted }))
      .mockResolvedValueOnce(response(true, { ok: true, quote: persisted }));
    vi.stubGlobal("fetch", fetchMock);

    let tree = prepareIntent();
    click(tree, "Review sequence");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => {
      tree = renderFlow();
      expect(text(tree)).toContain("Confirm sequence");
      const confirm = elements(tree).find(
        (node) => node.type === "button" && text(node.props.children).includes("Confirm sequence"),
      );
      expect(confirm?.props.disabled).toBe(false);
    });
    click(tree, "Confirm sequence");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      tree = renderFlow();
      expect(elements(tree).some(
        (node) => node.props["data-testid"] === "booking-sequence-done",
      )).toBe(true);
    });

    expect(text(tree)).toContain("Persisted create receipt");
    expect(text(tree)).toContain("CAD:5000");
    expect(text(tree)).not.toContain("Earlier quote");
  });

  it("keeps Done visible and warns against rebooking when saved-card reconciliation is pending", async () => {
    cardRequirement.mockResolvedValue({
      required: true,
      feeCents: 1_000,
      provider: "square",
      applicationId: "sq-app",
      locationId: "sq-location",
      environment: "sandbox",
    });
    savedCard.mockResolvedValue({ hasSavedCard: true, brand: "Visa", last4: "4242" });
    const authoritativeQuote = quote("Protected sequence", "a".repeat(64), 5_000);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(true, { ok: true, quote: authoritativeQuote }))
      .mockResolvedValueOnce(response(true, {
        ok: true,
        quote: authoritativeQuote,
        cardManagementPending: true,
      }));
    vi.stubGlobal("fetch", fetchMock);

    let tree = prepareIntent();
    click(tree, "Review sequence");
    await vi.waitFor(() => {
      tree = renderFlow();
      expect(elements(tree).some(
        (node) => node.props["data-testid"] === "booking-sequence-noshow-consent",
      )).toBe(true);
      expect(text(tree)).toContain("Visa");
    });
    const consent = elements(tree).find(
      (node) => node.props["data-testid"] === "booking-sequence-noshow-consent",
    );
    (consent?.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    tree = renderFlow();
    click(tree, "Confirm sequence");

    await vi.waitFor(() => {
      tree = renderFlow();
      expect(elements(tree).some(
        (node) => node.props["data-testid"] === "booking-sequence-done",
      )).toBe(true);
      expect(elements(tree).some(
        (node) => node.props["data-testid"] === "booking-sequence-card-pending",
      )).toBe(true);
    });
    expect(text(tree)).toMatch(/do not book again/i);
    const createBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(createBody).toMatchObject({
      noShowConsent: true,
      cardSourceId: null,
      cardVerificationToken: null,
    });
  });
  it.each(["missing booking id", "wrong fingerprint", "wrong salon"])("does not show Done for %s", async kind => {
    const quoted = quote("Quoted", "a".repeat(64), 5000);
    const persisted = { ...quoted,
      ...(kind === "wrong fingerprint" ? { pricingFingerprint: "b".repeat(64) } : {}),
      ...(kind === "wrong salon" ? { salonId: "77777777-7777-4777-8777-777777777777" } : {}),
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(true, { ok: true, quote: quoted }))
      .mockResolvedValueOnce(response(true, { ok: true, quote: persisted,
        ...(kind === "missing booking id" ? { bookingId: null } : {}),
      }));
    vi.stubGlobal("fetch", fetchMock);
    let tree = prepareIntent(); click(tree, "Review sequence");
    await vi.waitFor(() => {
      tree = renderFlow();
      const confirm = elements(tree).find(node => node.type === "button" && text(node.props.children).includes("Confirm sequence"));
      expect(confirm?.props.disabled).toBe(false);
    });
    click(tree, "Confirm sequence");
    await vi.waitFor(() => expect(navigation.replace).toHaveBeenCalledOnce());
    expect(elements(renderFlow()).some(node => node.props["data-testid"] === "booking-sequence-done")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["invalid_otp_session", "otp_session_used", "otp_required"])(
    "recovers %s with a fresh session and quote while retaining one booking intent",
    async (code) => {
      const initialQuote = quote("Initial", "a".repeat(64), 5_000);
      const freshQuote = quote("Fresh", "b".repeat(64), 5_500);
      const rejectedSession = code === "otp_required" ? null : "55555555-5555-4555-8555-555555555555";
      let sessionId = rejectedSession;
      const onOtpSessionInvalid = vi.fn(() => { sessionId = null; });
      const render = () => renderFlow({ otpSessionId: sessionId, onOtpSessionInvalid });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(response(true, { ok: true, quote: initialQuote }))
        .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ ok: false, code }) })
        .mockResolvedValueOnce(response(true, { ok: true, quote: freshQuote }))
        .mockResolvedValueOnce(response(true, { ok: true, quote: freshQuote }));
      vi.stubGlobal("fetch", fetchMock);
      prepareIntent();
      let tree = render();
      click(tree, "Review sequence");
      await vi.waitFor(() => {
        tree = render();
        expect(elements(tree).find(node => node.type === "button" && text(node).includes("Confirm sequence"))?.props.disabled).toBe(false);
      });
      click(tree, "Confirm sequence");
      await vi.waitFor(() => expect(onOtpSessionInvalid).toHaveBeenCalledOnce());
      tree = render();
      expect(text(tree)).toContain("Your details are kept");
      expect(elements(tree).find(node => node.props.id === "booking-sequence-date")?.props.value).toBe("2026-08-28");
      expect(elements(tree).find(node => node.props.id === "booking-sequence-time")?.props.value).toBe("11:00");
      expect(elements(tree).filter(node => node.type === "select").map(node => node.props.value)).toEqual(expect.arrayContaining([serviceId, secondServiceId]));
      expect(elements(tree).find(node => node.type === "button" && text(node).includes("Review sequence"))?.props.disabled).toBe(true);
      click(tree, "Review sequence");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(navigation.replace).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(`nq-pending-booking-create:${salonId}`)).toBeNull();

      sessionId = "55555555-5555-4555-8555-555555555556";
      tree = render();
      expect(text(tree)).not.toContain("Your verification is no longer valid");
      expect(elements(tree).some(node => node.type === "button" && text(node).includes("Confirm sequence"))).toBe(false);
      click(tree, "Review sequence");
      await vi.waitFor(() => {
        tree = render();
        expect(elements(tree).find(node => node.type === "button" && text(node).includes("Confirm sequence"))?.props.disabled).toBe(false);
      });
      // Duplicate clicks from the same render must not start another dispatch.
      click(tree, "Confirm sequence");
      click(tree, "Confirm sequence");
      await vi.waitFor(() => expect(elements(render()).some(node => node.props["data-testid"] === "booking-sequence-done")).toBe(true));
      expect(fetchMock).toHaveBeenCalledTimes(4);
      const first = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
      const requote = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
      const retry = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body));
      expect(first.otpSessionId).toBe(rejectedSession);
      expect(requote).toEqual({ ...first.intent, otpSessionId: sessionId });
      expect(retry.intent).toEqual({ ...first.intent, otpSessionId: sessionId });
      expect(retry.otpSessionId).toBe(sessionId);
      expect(retry.expectedPricingFingerprint).toBe(freshQuote.pricingFingerprint);
      expect(retry.cardSourceId).toBeNull();
      expect(cardRequirement.mock.calls.length).toBeGreaterThanOrEqual(2);
    },
  );

  it("discards tokenized card authority and rereads saved-card binding after OTP renewal", async () => {
    cardRequirement.mockResolvedValue({ required: true, feeCents: 1_000, provider: "square", applicationId: "sandbox-app", locationId: "sandbox-location", environment: "sandbox" });
    savedCard.mockResolvedValue({ hasSavedCard: false });
    const quoted = quote("Review", "a".repeat(64), 5_000);
    const newSession = "55555555-5555-4555-8555-555555555556";
    let sessionId: string | null = "55555555-5555-4555-8555-555555555555";
    const onOtpSessionInvalid = vi.fn(() => { sessionId = null; });
    const render = () => renderFlow({ otpSessionId: sessionId, onOtpSessionInvalid });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(true, { ok: true, quote: quoted }))
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ ok: false, code: "invalid_otp_session" }) })
      .mockResolvedValueOnce(response(true, { ok: true, quote: quoted }))
      .mockResolvedValueOnce(response(true, { ok: true, quote: quoted }));
    vi.stubGlobal("fetch", fetchMock);
    prepareIntent();
    let tree = render();
    click(tree, "Review sequence");
    await vi.waitFor(() => {
      tree = render();
      expect(elements(tree).some(node => node.props["data-testid"] === "booking-sequence-noshow-consent")).toBe(true);
    });
    const consent = elements(tree).find(node => node.props["data-testid"] === "booking-sequence-noshow-consent");
    (consent?.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    tree = render();
    const capture = elements(tree).find(node => "confirmationKey" in node.props);
    const tokenize = vi.fn().mockResolvedValue({ token: "synthetic-old-source", verificationToken: "synthetic-old-verification" });
    (capture?.props.ref as { current: unknown }).current = { tokenize, clearError: vi.fn() };
    click(tree, "Confirm sequence");
    await vi.waitFor(() => expect(onOtpSessionInvalid).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).cardSourceId).toBe("synthetic-old-source");
    expect(elements(render()).some(node => "confirmationKey" in node.props)).toBe(false);

    sessionId = newSession;
    savedCard.mockResolvedValue({ hasSavedCard: true, brand: "Visa", last4: "4242" });
    tree = render();
    click(tree, "Review sequence");
    await vi.waitFor(() => {
      tree = render();
      expect(text(tree)).toContain("Visa");
    });
    const renewedConsent = elements(tree).find(node => node.props["data-testid"] === "booking-sequence-noshow-consent");
    expect(renewedConsent?.props.checked).toBe(false);
    expect(elements(tree).find(node => node.type === "button" && text(node).includes("Confirm sequence"))?.props.disabled).toBe(true);
    (renewedConsent?.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    tree = render();
    click(tree, "Confirm sequence");
    await vi.waitFor(() => expect(elements(render()).some(node => node.props["data-testid"] === "booking-sequence-done")).toBe(true));
    expect(savedCard).toHaveBeenLastCalledWith({ salonId, otpSessionId: newSession });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toMatchObject({ otpSessionId: newSession, cardSourceId: null, cardVerificationToken: null, noShowConsent: true });
    expect(tokenize).toHaveBeenCalledOnce();
  });

  it("keeps ambiguous create outcomes on recovery instead of reopening OTP or dispatching again", async () => {
    const quoted = quote("Review", "a".repeat(64), 5_000);
    const onOtpSessionInvalid = vi.fn();
    const render = () => renderFlow({ onOtpSessionInvalid });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(true, { ok: true, quote: quoted }))
      // A server error with an OTP-looking body is not a definite rejection.
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ ok: false, code: "invalid_otp_session" }) });
    vi.stubGlobal("fetch", fetchMock);
    prepareIntent();
    let tree = render();
    click(tree, "Review sequence");
    await vi.waitFor(() => {
      tree = render();
      expect(elements(tree).find(node => node.type === "button" && text(node).includes("Confirm sequence"))?.props.disabled).toBe(false);
    });
    click(tree, "Confirm sequence");
    await vi.waitFor(() => expect(navigation.replace).toHaveBeenCalledOnce());
    expect(onOtpSessionInvalid).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(`nq-pending-booking-create:${salonId}`)).toContain("/booking/recover-booking#booking=sequence.");
    click(render(), "Confirm sequence");
    await vi.waitFor(() => expect(navigation.replace).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onOtpSessionInvalid).not.toHaveBeenCalled();
  });

});
