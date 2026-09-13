import type { ComponentProps, ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Execute the canonical component and its event handlers in the node-only unit
// suite. Network responses and scheduling are controlled; no OTP is sent.
const hooks = vi.hoisted(() => ({
  cursor: 0,
  values: [] as unknown[],
  pending: [] as Promise<unknown>[],
}));

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useRef: <T,>(initial: T) => {
      const index = hooks.cursor++;
      return (hooks.values[index] ??= { current: initial }) as { current: T };
    },
    useState: <T,>(initial: T | (() => T)) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) {
        hooks.values[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      }
      return [hooks.values[index] as T, (value: T | ((current: T) => T)) => {
        hooks.values[index] = typeof value === "function"
          ? (value as (current: T) => T)(hooks.values[index] as T)
          : value;
      }] as const;
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.values[index] as { deps?: readonly unknown[]; cleanup?: () => void } | undefined;
      if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
        previous?.cleanup?.();
        hooks.values[index] = { deps, cleanup: effect() };
      }
    },
    useTransition: () => {
      const index = hooks.cursor++;
      hooks.values[index] ??= 0;
      return [Number(hooks.values[index]) > 0, (work: () => unknown) => {
        hooks.values[index] = Number(hooks.values[index]) + 1;
        hooks.pending.push(Promise.resolve(work()).finally(() => {
          hooks.values[index] = Number(hooks.values[index]) - 1;
        }));
      }] as const;
    },
  };
});

vi.mock("@/shared/lib/motionClient", () => ({ motion: { div: "div" } }));
vi.mock("@/components/ui/Button", () => ({ Button: "mock-button" }));
vi.mock("@/components/booking/LuxuryBookingCta", () => ({ LuxuryBookingCta: "mock-cta" }));

import { BookingFlowOtpPanel } from "../BookingFlowOtpPanel";
import { bookingEn } from "@/shared/i18n/booking/en";
import { bookingVi } from "@/shared/i18n/booking/vi";

type Props = ComponentProps<typeof BookingFlowOtpPanel>;
type Node = ReactElement<Record<string, unknown>>;
type Reply = { ok: boolean; status: number; json: () => Promise<Record<string, unknown>> };
let props: Props;
let nextTest = 0;

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
  return nodes(BookingFlowOtpPanel(props));
}

function byTestId(id: string) {
  return render().find((node) => node.props["data-testid"] === id);
}

function codeInput() {
  return render().find((node) => node.props.id === "otp-code")!;
}

function verifyButton() {
  return render().find((node) => (node.type as unknown) === "mock-cta")!;
}

function click(node: Node | undefined) {
  expect(node).toBeDefined();
  expect(node!.props.disabled).not.toBe(true);
  (node!.props.onClick as () => void)();
}

function enterCode() {
  expect(codeInput().props.disabled).toBe(false);
  (codeInput().props.onChange as (event: unknown) => void)({ target: { value: "123456" } });
}

function response(ok: boolean, body: Record<string, unknown> = {}): Reply {
  return { ok, status: ok ? 200 : 503, json: async () => ({ ok, ...body }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

beforeEach(() => {
  hooks.cursor = 0;
  hooks.values = [];
  hooks.pending = [];
  vi.useFakeTimers();
  props = {
    t: bookingEn,
    shopSlug: `e2e-otp-delivery-${++nextTest}`,
    clientPhone: "+16045550191",
    clientEmail: "synthetic@example.test",
    emailChannelEnabled: true,
    salonPhone: "+16045550192",
    stepDir: 1,
    reducedMotion: true,
    stepTransition: { duration: 0, ease: [0, 0, 1, 1] },
    isOptional: false,
    onVerified: vi.fn(),
    onBack: vi.fn(),
  };
  // Unhandled paths fail tests instead of making a real network request.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected fetch"); }));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("booking OTP independent channel recovery", () => {
  it.each([bookingEn, bookingVi])("phone-only offer verification never sends or checks email", async (messages) => {
    props.t = messages;
    props.purpose = "phone";
    props.isOptional = true;
    props.onSkip = vi.fn();
    const fetchMock = vi.fn(async (url: string) => response(true,
      url.endsWith("verify") ? { sessionId: "sms-session" } : { deliveryAttemptId: "sms-attempt" }));
    vi.stubGlobal("fetch", fetchMock);
    render();
    await Promise.all(hooks.pending);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(byTestId("otp-email-fallback")).toBeUndefined();
    expect(byTestId("otp-email-sent")).toBeUndefined();
    enterCode();
    click(verifyButton());
    await Promise.all(hooks.pending);
    const verifyCall = vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/booking-otp/verify");
    expect(JSON.parse(String(verifyCall?.[1]?.body))).not.toHaveProperty("email");
    expect(props.onVerified).toHaveBeenCalledWith("sms-session");
  });

  it.each([bookingEn, bookingVi])("SMS failure in offer verification stops the sending caption and leaves skip and salon call available", async (messages) => {
    props.t = messages;
    props.purpose = "phone"; props.isOptional = true; props.onSkip = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => response(false)));
    render(); await Promise.all(hooks.pending);
    expect(codeInput().props.disabled).toBe(true);
    expect(byTestId("otp-delivery-pending")).toBeUndefined();
    expect(byTestId("otp-sms-error")?.props.children).toBe(messages.bookingErrors.otpSendFailed);
    expect(byTestId("otp-email-fallback")).toBeUndefined();
    click(render().find((node) => node.props.onClick === props.onSkip));
    expect(props.onSkip).toHaveBeenCalledOnce();
    expect(render().some((node) => node.props.href === `tel:${props.salonPhone}`)).toBe(true);
  });

  it.each([
    ["en", "sms-first"], ["en", "email-first"],
    ["vi", "sms-first"], ["vi", "email-first"],
  ])("uses the successful email code despite SMS failure (%s, %s)", async (language, order) => {
    props.t = language === "vi" ? bookingVi : bookingEn;
    const sms = deferred<Reply>();
    const email = deferred<Reply>();
    const fetchMock = vi.fn(async (url: string, options: RequestInit) => {
      if (url === "/api/booking-otp/verify") return response(true, { sessionId: "verified-synthetic-session" });
      expect(url).toBe("/api/booking-otp/send");
      const body = JSON.parse(String(options.body));
      return body.channel === "email" ? email.promise : sms.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    render();
    expect(codeInput().props.disabled).toBe(true);
    if (order === "sms-first") {
      sms.resolve(response(false));
      await flush();
      expect(codeInput().props.disabled).toBe(true);
      email.resolve(response(true));
    } else {
      email.resolve(response(true));
      await flush();
      expect(codeInput().props.disabled).toBe(false);
      sms.resolve(response(false));
    }
    await Promise.all(hooks.pending);
    expect(byTestId("otp-delivery-email")).toBeDefined();
    expect(byTestId("otp-delivery-sms")).toBeUndefined();
    expect(byTestId("otp-email-sent")).toBeDefined();
    expect(byTestId("otp-sms-error")?.props.children).toBe(props.t.bookingErrors.otpSendFailed);
    expect(byTestId("otp-email-error")).toBeUndefined();
    enterCode();
    click(verifyButton());
    await Promise.all(hooks.pending);
    expect(props.onVerified).toHaveBeenCalledExactlyOnceWith("verified-synthetic-session");
    const verifyRequest = fetchMock.mock.calls.find(([url]) => url === "/api/booking-otp/verify")!;
    expect(JSON.parse(String(verifyRequest[1].body))).toEqual({
      phone: props.clientPhone, shopSlug: props.shopSlug, code: "123456", email: props.clientEmail,
    });
  });

  it.each(["http", "network"])("both channels failing keeps email entry, resend and call-salon reachable (%s)", async (failure) => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (failure === "network") throw new Error("Synthetic unavailable");
      return response(false);
    }));
    render();
    await Promise.all(hooks.pending);
    expect(codeInput().props.disabled).toBe(true);
    expect(verifyButton().props.disabled).toBe(true);
    expect(byTestId("otp-sms-error")).toBeDefined();
    expect(byTestId("otp-email-error")?.props.children).toBe(bookingEn.bookingErrors.otpEmailSendFailed);
    expect(render().some((node) => node.props.href === `tel:${props.salonPhone}`)).toBe(true);
    click(byTestId("otp-email-fallback"));
    expect(byTestId("otp-email-input")?.props.value).toBe(props.clientEmail);
    expect(byTestId("otp-email-send")?.props.disabled).toBe(false);
    expect(props.onVerified).not.toHaveBeenCalled();
  });

  it("accepts a newly entered email after SMS fails with no email on file", async () => {
    props.clientEmail = "";
    const fetchMock = vi.fn(async (url: string, options: RequestInit) => {
      if (url === "/api/booking-otp/verify") return response(true, { sessionId: "email-recovery" });
      return response(JSON.parse(String(options.body)).channel === "email");
    });
    vi.stubGlobal("fetch", fetchMock);
    render();
    await Promise.all(hooks.pending);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    click(byTestId("otp-email-fallback"));
    expect(byTestId("otp-email-send")?.props.disabled).toBe(true);
    (byTestId("otp-email-input")!.props.onChange as (event: unknown) => void)({ target: { value: "new@example.test" } });
    click(byTestId("otp-email-send"));
    await Promise.all(hooks.pending);
    enterCode();
    click(verifyButton());
    await Promise.all(hooks.pending);
    const verifyRequest = fetchMock.mock.calls.find(([url]) => url === "/api/booking-otp/verify")!;
    expect(JSON.parse(String(verifyRequest[1].body)).email).toBe("new@example.test");
    expect(props.onVerified).toHaveBeenCalledExactlyOnceWith("email-recovery");
  });

  it("keeps a successful SMS usable when email fails and carries its exact receipt", async () => {
    const attemptId = "77777777-7777-4777-8777-777777777777";
    const fetchMock = vi.fn(async (url: string, options: RequestInit) => {
      if (url === "/api/booking-otp/verify") return response(true, { sessionId: "sms-recovery" });
      return JSON.parse(String(options.body)).channel === "email"
        ? response(false)
        : response(true, { deliveryAttemptId: attemptId });
    });
    vi.stubGlobal("fetch", fetchMock);
    render();
    await Promise.all(hooks.pending);
    expect(byTestId("otp-delivery-sms")).toBeDefined();
    expect(byTestId("otp-delivery-email")).toBeUndefined();
    expect(byTestId("otp-email-error")).toBeDefined();
    expect(byTestId("otp-sms-error")).toBeUndefined();
    enterCode();
    click(verifyButton());
    await Promise.all(hooks.pending);
    const verifyRequest = fetchMock.mock.calls.find(([url]) => url === "/api/booking-otp/verify")!;
    expect(JSON.parse(String(verifyRequest[1].body))).toEqual({
      phone: props.clientPhone, shopSlug: props.shopSlug, code: "123456", deliveryAttemptId: attemptId,
    });
  });

  it("honors a disabled salon email channel without hiding the call-salon exit", async () => {
    props.emailChannelEnabled = false;
    vi.stubGlobal("fetch", vi.fn(async () => response(false)));
    render();
    await Promise.all(hooks.pending);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(byTestId("otp-email-fallback")).toBeUndefined();
    expect(byTestId("otp-email-send")).toBeUndefined();
    expect(byTestId("otp-email-resend")).toBeUndefined();
    expect(render().some((node) => node.props.href === `tel:${props.salonPhone}`)).toBe(true);
  });

  it("resends email without dispatching another SMS and reports a failed email retry", async () => {
    let emailCalls = 0;
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      if (JSON.parse(String(options.body)).channel !== "email") return response(false);
      return response(++emailCalls !== 2);
    });
    vi.stubGlobal("fetch", fetchMock);
    render();
    await Promise.all(hooks.pending);
    click(byTestId("otp-email-resend"));
    await Promise.all(hooks.pending);
    expect(byTestId("otp-email-error")).toBeDefined();
    expect(codeInput().props.disabled).toBe(false);
    click(byTestId("otp-email-resend"));
    await Promise.all(hooks.pending);
    expect(byTestId("otp-email-error")).toBeUndefined();
    expect(emailCalls).toBe(3);
    expect(fetchMock.mock.calls.filter(([, options]) => !JSON.parse(String(options.body)).channel)).toHaveLength(1);
  });

  it("restores a recent SMS receipt on remount without a duplicate SMS", async () => {
    props.emailChannelEnabled = false;
    vi.stubGlobal("fetch", vi.fn(async () => response(true, { deliveryAttemptId: "77777777-7777-4777-8777-777777777777" })));
    render();
    await Promise.all(hooks.pending);
    vi.clearAllTimers();
    hooks.values = [];
    hooks.pending = [];
    render();
    await Promise.all(hooks.pending);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(codeInput().props.disabled).toBe(false);
    expect(byTestId("otp-delivery-sms")).toBeDefined();
  });
});
