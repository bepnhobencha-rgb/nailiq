import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[] }));
const navigation = vi.hoisted(() => ({ replace: vi.fn(), search: "mode=sequence" }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => {
      const i = hooks.cursor++;
      if (!(i in hooks.values)) hooks.values[i] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [hooks.values[i] as T, (next: T | ((current: T) => T)) => {
        hooks.values[i] = typeof next === "function" ? (next as (current: T) => T)(hooks.values[i] as T) : next;
      }] as const;
    },
    useRef: <T,>(initial: T) => {
      const i = hooks.cursor++;
      if (!(i in hooks.values)) hooks.values[i] = { current: initial };
      return hooks.values[i] as { current: T };
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const i = hooks.cursor++;
      const previous = hooks.values[i] as { deps?: readonly unknown[]; cleanup?: () => void } | undefined;
      if (!previous || !deps || deps.some((value, index) => !Object.is(value, previous.deps?.[index]))) {
        previous?.cleanup?.();
        hooks.values[i] = { deps, cleanup: effect() };
      }
    },
    useCallback: <T,>(fn: T) => fn,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => boolean) => getSnapshot(),
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
  useSearchParams: () => new URLSearchParams(navigation.search),
  usePathname: () => "/synthetic-salon",
}));
vi.mock("../BookingFlow", () => ({ BookingFlow: () => null }));
vi.mock("../BookingGroupFlow", () => ({ BookingGroupFlow: () => null }));
vi.mock("../BookingSequenceFlow", () => ({ BookingSequenceFlow: () => null }));
vi.mock("../CountryPhoneField", () => ({ default: () => null }));
vi.mock("../VoiceBookingButton", () => ({ VoiceBookingButton: () => null }));
vi.mock("@/shared/booking/groupSchedulerCore", () => ({ MAX_WAVES: 3 }));

import { BookingTypeSwitcher } from "../BookingTypeSwitcher";
import { BookingFlow } from "../BookingFlow";
import { BookingSequenceFlow } from "../BookingSequenceFlow";
import { bookingEn } from "@/shared/i18n/booking/en";
import type { BookingSalonMeta, BookingStaffItem } from "@/shared/booking/loadBookingServices";

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function byId(tree: Node, id: string) {
  const node = nodes(tree).find(item => item.props["data-testid"] === id || item.props.testId === id);
  expect(node, id).toBeDefined();
  return node!;
}
function sequence(tree: Node) {
  return nodes(tree).find(node => node.type === BookingSequenceFlow);
}
function gate(tree: Node) {
  return nodes(tree).find(node => typeof node.props.onVerified === "function" && "phoneDigits" in node.props);
}
const salonId = "11111111-1111-4111-8111-111111111111";
const oldSession = "55555555-5555-4555-8555-555555555555";
const freshSession = "55555555-5555-4555-8555-555555555556";
const baseProps = {
  t: bookingEn,
  shopSlug: "synthetic-salon",
  services: [], addOns: [], combos: [], categories: [], capabilityRows: [],
  staff: [{ id: "33333333-3333-4333-8333-333333333333", name: "Synthetic Staff" }] as BookingStaffItem[],
  salon: { id: salonId, timezone: "America/Vancouver", phoneOtpEnabled: true, emailLinksEnabled: true } as BookingSalonMeta,
  groupBookingEnabled: false,
  multiServiceSequenceEnabled: true,
  smsConsentRequired: false,
};
function render(props = baseProps) {
  hooks.cursor = 0;
  return BookingTypeSwitcher(props);
}

describe("sequence OTP recovery parent gate", () => {
  beforeEach(() => {
    hooks.cursor = 0; hooks.values = [];
    navigation.search = "mode=sequence";
    vi.useFakeTimers();
    const stored = new Map<string, string>();
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    vi.stubGlobal("window", { sessionStorage: storage, dispatchEvent: vi.fn() });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ found: false }) }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function enterCustomer(props = baseProps) {
    let tree = render(props);
    (byId(tree, "booking-entry-phone").props.onChange as (value: string) => void)("+16045550123");
    tree = render(props);
    await vi.advanceTimersByTimeAsync(401);
    tree = render(props);
    (byId(tree, "booking-entry-name").props.onChange as (event: unknown) => void)({ target: { value: "Synthetic Guest" } });
    tree = render(props);
    await vi.advanceTimersByTimeAsync(401);
    return render(props);
  }

  it("reopens OTP for the same identity without remounting the sequence or losing the customer", async () => {
    let tree = await enterCustomer();
    expect(sequence(tree)).toBeUndefined();
    await (gate(tree)?.props.onVerified as (session: string) => Promise<void>)(oldSession);
    tree = render();
    const before = sequence(tree)!;
    expect(before.props.otpSessionId).toBe(oldSession);
    expect(before.props.customer).toMatchObject({ name: "Synthetic Guest", phone: "+16045550123" });
    const focus = vi.fn();
    (byId(tree, "booking-phone-gate").props.ref as { current: unknown }).current = { focus };
    (before.props.onOtpSessionInvalid as () => void)();
    tree = render();
    const during = sequence(tree)!;
    expect(during).toBeDefined();
    expect(during.key).toBe(before.key);
    expect(during.props.customer).toEqual(before.props.customer);
    expect(during.props.otpSessionId).toBeNull();
    expect(gate(tree)).toBeDefined();
    expect(byId(tree, "booking-type-individual").props.disabled).toBe(true);
    expect(byId(tree, "booking-gate-otp-recovery")).toBeDefined();
    expect(focus).toHaveBeenCalledOnce();

    await (gate(tree)?.props.onVerified as (session: string) => Promise<void>)(freshSession);
    tree = render();
    expect(sequence(tree)?.key).toBe(before.key);
    expect(sequence(tree)?.props.otpSessionId).toBe(freshSession);
    expect(gate(tree)).toBeUndefined();
    expect(byId(tree, "booking-type-individual").props.disabled).toBe(false);
  });

  it("does not carry recovery authority to another phone or salon", async () => {
    let tree = await enterCustomer();
    await (gate(tree)?.props.onVerified as (session: string) => Promise<void>)(oldSession);
    tree = render();
    (sequence(tree)?.props.onOtpSessionInvalid as () => void)();
    tree = render();
    (byId(tree, "booking-entry-phone").props.onChange as (value: string) => void)("+16045550124");
    tree = render();
    expect(sequence(tree)).toBeUndefined();
    expect(nodes(tree).some(node => node.props["data-testid"] === "booking-gate-otp-recovery")).toBe(false);
    tree = render({ ...baseProps, salon: { ...baseProps.salon, id: "11111111-1111-4111-8111-111111111112" } });
    expect(sequence(tree)).toBeUndefined();
  });

  it("can recover server-required OTP even if the initial salon metadata did not require it", async () => {
    const props = { ...baseProps, salon: { ...baseProps.salon, phoneOtpEnabled: false } };
    let tree = await enterCustomer(props);
    const before = sequence(tree)!;
    expect(before.props.otpSessionId).toBeNull();
    expect(gate(tree)).toBeUndefined();
    (before.props.onOtpSessionInvalid as () => void)();
    tree = render(props);
    expect(sequence(tree)?.key).toBe(before.key);
    expect(gate(tree)).toBeDefined();
    await (gate(tree)?.props.onVerified as (session: string) => Promise<void>)(freshSession);
    tree = render(props);
    expect(sequence(tree)?.props.otpSessionId).toBe(freshSession);
  });

  it("does not let a mode change or individual URL reuse sequence recovery as verification", async () => {
    let tree = await enterCustomer();
    await (gate(tree)?.props.onVerified as (session: string) => Promise<void>)(oldSession);
    tree = render();
    (sequence(tree)?.props.onOtpSessionInvalid as () => void)();
    tree = render();
    expect(byId(tree, "booking-type-individual").props.disabled).toBe(true);
    // Even an invoked stale/programmatic handler cannot use the sequence-only
    // recovery allowance to expose another flow with an invalid session.
    navigation.search = "mode=individual";
    (byId(tree, "booking-type-individual").props.onClick as () => void)();
    tree = render();
    expect(sequence(tree)).toBeUndefined();
    expect(nodes(tree).some(node => node.type === BookingFlow)).toBe(false);
    expect(gate(tree)).toBeDefined();

    // A reload through ?mode=individual has no in-memory OTP authority either.
    vi.clearAllTimers();
    hooks.values = [];
    tree = await enterCustomer();
    expect(sequence(tree)).toBeUndefined();
    expect(nodes(tree).some(node => node.type === BookingFlow)).toBe(false);
    await (gate(tree)?.props.onVerified as (session: string) => Promise<void>)(freshSession);
    tree = render();
    expect(nodes(tree).some(node => node.type === BookingFlow)).toBe(true);
    expect(sequence(tree)).toBeUndefined();
  });
});
