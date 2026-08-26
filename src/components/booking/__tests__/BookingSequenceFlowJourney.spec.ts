import type { ReactElement } from "react";

import { beforeEach, describe, expect, it, vi } from "vitest";

const hookState = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[] }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      effect();
    },
    useMemo: <T,>(factory: () => T) => factory(),
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

vi.mock("@/shared/lib/salonTime", () => ({
  salonToday: () => "2026-08-21",
  salonWallTimeToUtcIso: () => "2026-08-28T18:00:00.000Z",
}));
vi.mock("@/shared/lib/currencyFormat", () => ({
  formatCurrency: (cents: number, currency: string) => `${currency}:${cents}`,
}));

import type { BookingSequenceQuote } from "@/shared/booking/bookingSequenceServer";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import type {
  BookingSalonMeta,
  BookingStaffItem,
} from "@/shared/booking/loadBookingServices";

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
        serviceName: `${label} A`,
        staffName: "Mai",
        serviceStartUtc: "2026-08-28T18:00:00.000Z",
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
        serviceName: `${label} B`,
        staffName: "Mai",
        serviceStartUtc: "2026-08-28T18:45:00.000Z",
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

function response(ok: boolean, body: unknown) {
  return { ok, json: async () => body } as Response;
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

function renderFlow() {
  hookState.cursor = 0;
  return BookingSequenceFlow({
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
  beforeEach(async () => {
    hookState.cursor = 0;
    hookState.values = [];
    vi.restoreAllMocks();
    vi.resetModules();
    ({ BookingSequenceFlow } = await import("../BookingSequenceFlow"));
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  it("keeps one intent through pricing_changed and requires an explicit reconfirm", async () => {
    const quoted = quote("Initial quote", "a".repeat(64), 5_000);
    const changed = quote("Updated quote", "b".repeat(64), 5_500);
    const persisted = quote("Persisted create", "c".repeat(64), 5_500);
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
    });
    click(tree, "Confirm sequence");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      tree = renderFlow();
      expect(text(tree)).toContain("Price or timing changed");
      expect(text(tree)).toContain("Confirm updated price");
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
    const persisted = quote("Persisted create receipt", "c".repeat(64), 5_900);
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
    expect(text(tree)).toContain("CAD:5900");
    expect(text(tree)).not.toContain("Earlier quote");
  });
});
