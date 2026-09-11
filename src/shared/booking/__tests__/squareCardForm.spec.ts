import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redactObservabilityContext } from "@/shared/observability/privacy";
import {
  loadSquareWebPaymentsSdk, mountSquareCardForm, safeSquareTokenizationStatus,
  type SquareCard, type SquareGlobal,
} from "../squareCardForm";

const SANDBOX = "https://sandbox.web.squarecdn.com/v1/square.js";
const PRODUCTION = "https://web.squarecdn.com/v1/square.js";

it.each([["Invalid", "INVALID"], ["Error", "ERROR"], ["Cancel", "CANCEL"],
  ["OK", "OK"], ["private-provider-details", "OTHER"], [null, "OTHER"]])(
  "preserves known tokenization status %s without arbitrary provider details", (input, expected) => {
    expect(safeSquareTokenizationStatus(input)).toBe(expected);
  },
);

it("retains allowlisted SDK failure diagnostics through the privacy boundary", () => {
  expect(redactObservabilityContext({ tags: {
    square_error_kind: "WebSdkEmbedError", payment_step: "payments_init",
    source_token: "PRIVATE_TEST_VALUE",
  } })).toEqual({ tags: {
    square_error_kind: "WebSdkEmbedError", payment_step: "payments_init",
    source_token: "<redacted>",
  } });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

class FakeScript extends EventTarget {
  src = "";
  async = false;
  constructor(private doc: FakeDocument) { super(); }
  remove() { this.doc.scripts = this.doc.scripts.filter(script => script !== this); }
}
class FakeDocument {
  scripts: FakeScript[] = [];
  head = { appendChild: (script: FakeScript) => { this.scripts.push(script); return script; } };
  createElement() { return new FakeScript(this); }
  querySelector(selector: string) {
    const source = /^script\[src="(.+)"\]$/.exec(selector)?.[1];
    return this.scripts.find(script => script.src === source) ?? null;
  }
  addScript(src: string) { const script = this.createElement(); script.src = src; this.head.appendChild(script); return script; }
}

function cardFixture() {
  return {
    attach: vi.fn(async (selector: string) => { void selector; }),
    destroy: vi.fn(async () => true),
    tokenize: vi.fn(async () => ({ status: "OK", token: "synthetic-test-token" })),
  } satisfies SquareCard;
}
function mountFixture(overrides: { selector?: string } = {}) {
  const card = cardFixture();
  const payments = { card: vi.fn<() => Promise<SquareCard>>(async () => card) };
  const sdk = { payments: vi.fn(() => payments) };
  const input = { loadSdk: vi.fn<() => Promise<SquareGlobal>>(async () => sdk), applicationId: "sandbox-qa-app", locationId: "qa-location",
    selector: "#card-instance-1", onReady: vi.fn(), onError: vi.fn(), ...overrides };
  return { card, payments, sdk, input, start: () => mountSquareCardForm(input) };
}

describe("Square SDK script lifecycle", () => {
  let doc: FakeDocument;
  let browser: { Square?: unknown };
  beforeEach(() => {
    vi.useFakeTimers();
    doc = new FakeDocument(); browser = {};
    vi.stubGlobal("document", doc); vi.stubGlobal("window", browser);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("shares a concurrent load and accepts only a valid matching SDK global", async () => {
    const first = loadSquareWebPaymentsSdk("sandbox");
    expect(loadSquareWebPaymentsSdk("sandbox")).toBe(first);
    expect(doc.scripts.map(script => script.src)).toEqual([SANDBOX]);
    const sdk = { payments: vi.fn() }; browser.Square = sdk;
    doc.scripts[0].dispatchEvent(new Event("load"));
    await expect(first).resolves.toBe(sdk);
    await expect(loadSquareWebPaymentsSdk("sandbox")).resolves.toBe(sdk);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("adopts an existing pending script without appending another", async () => {
    const script = doc.addScript(SANDBOX);
    const pending = loadSquareWebPaymentsSdk("sandbox");
    browser.Square = { payments: vi.fn() };
    script.dispatchEvent(new Event("load"));
    await expect(pending).resolves.toBe(browser.Square);
    expect(doc.scripts).toEqual([script]);
  });

  it("accepts a matching callable namespace that exposes payments", async () => {
    doc.addScript(SANDBOX);
    browser.Square = Object.assign(() => {}, { payments: vi.fn() });
    await expect(loadSquareWebPaymentsSdk("sandbox")).resolves.toBe(browser.Square);
  });

  it("removes a failed script and permits an explicit fresh retry", async () => {
    const pending = loadSquareWebPaymentsSdk("sandbox");
    const rejected = expect(pending).rejects.toMatchObject({ code: "sdk_load_failed" });
    const first = doc.scripts[0]; first.dispatchEvent(new Event("error"));
    await rejected;
    expect(doc.scripts).toHaveLength(0);
    const retry = loadSquareWebPaymentsSdk("sandbox");
    expect(doc.scripts[0]).not.toBe(first);
    browser.Square = { payments: vi.fn() }; doc.scripts[0].dispatchEvent(new Event("load"));
    await expect(retry).resolves.toBe(browser.Square);
  });

  it("bounds a missed load/error event and clears the timed-out script for retry", async () => {
    doc.addScript(SANDBOX); // Its earlier error event could already have been missed.
    const pending = loadSquareWebPaymentsSdk("sandbox");
    const rejected = expect(pending).rejects.toMatchObject({ code: "sdk_load_timeout" });
    await vi.advanceTimersByTimeAsync(12_000);
    await rejected;
    expect(doc.scripts).toHaveLength(0);
    const retry = loadSquareWebPaymentsSdk("sandbox");
    browser.Square = { payments: vi.fn() }; doc.scripts[0].dispatchEvent(new Event("load"));
    await expect(retry).resolves.toBe(browser.Square);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [undefined, "sdk_no_global"], [{ payments: "not-a-function" }, "sdk_invalid_global"],
  ])("rejects load completion without a usable global (%s)", async (value, code) => {
    const pending = loadSquareWebPaymentsSdk("sandbox");
    const rejected = expect(pending).rejects.toMatchObject({ code });
    browser.Square = value; doc.scripts[0].dispatchEvent(new Event("load"));
    await rejected;
    expect(doc.scripts).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an already loaded opposite environment", async () => {
    doc.addScript(PRODUCTION); browser.Square = { payments: vi.fn() };
    await expect(loadSquareWebPaymentsSdk("sandbox")).rejects.toMatchObject({ code: "sdk_environment_conflict" });
    expect(doc.scripts.map(script => script.src)).toEqual([PRODUCTION]);
  });

  it("rejects opposite environment while the first script is pending", async () => {
    const pending = loadSquareWebPaymentsSdk("sandbox");
    await expect(loadSquareWebPaymentsSdk("production")).rejects.toMatchObject({ code: "sdk_environment_conflict" });
    browser.Square = { payments: vi.fn() }; doc.scripts[0].dispatchEvent(new Event("load"));
    await pending;
  });

  it("does not trust an unlabelled pre-existing SDK global", async () => {
    browser.Square = { payments: vi.fn() };
    await expect(loadSquareWebPaymentsSdk("sandbox")).rejects.toMatchObject({ code: "sdk_environment_conflict" });
    expect(doc.scripts).toHaveLength(0);
  });

  it("rejects an invalid existing global without attempting initialization", async () => {
    doc.addScript(SANDBOX); browser.Square = { payments: "invalid" };
    await expect(loadSquareWebPaymentsSdk("sandbox")).rejects.toMatchObject({ code: "sdk_invalid_global" });
  });

  it("rejects invalid runtime environments before reading browser globals", async () => {
    vi.unstubAllGlobals();
    await expect(loadSquareWebPaymentsSdk("invalid" as "sandbox")).rejects.toMatchObject({ code: "sdk_environment_invalid" });
  });

  it("reports a blocked script append as a safe load failure and clears timers", async () => {
    doc.head.appendChild = () => { throw new Error("synthetic-private-details"); };
    await expect(loadSquareWebPaymentsSdk("sandbox")).rejects.toMatchObject({ code: "sdk_load_failed" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Square card form ownership and error truth", () => {
  it("publishes ready only after attach completes and never tokenizes by mounting", async () => {
    const f = mountFixture(); const attached = deferred<void>();
    f.card.attach.mockImplementation(() => attached.promise);
    const cancel = f.start(); await flush();
    expect(f.sdk.payments).toHaveBeenCalledWith("sandbox-qa-app", "qa-location");
    expect(f.card.attach).toHaveBeenCalledWith("#card-instance-1");
    expect(f.input.onReady).not.toHaveBeenCalled();
    attached.resolve(); await flush();
    expect(f.input.onReady).toHaveBeenCalledExactlyOnceWith(f.card);
    expect(f.card.tokenize).not.toHaveBeenCalled();
    cancel(); cancel(); await flush();
    expect(f.card.destroy).toHaveBeenCalledTimes(1);
  });

  it.each(["sdk_load", "payments_init", "card_create", "card_attach"] as const)(
    "retains the actual failing stage %s and only its allowlisted SDK name", async stage => {
      const f = mountFixture();
      const error = Object.assign(new Error("PRIVATE_CARD_DATA"), { name: "WebSdkEmbedError" });
      if (stage === "sdk_load") f.input.loadSdk.mockRejectedValue(error);
      else if (stage === "payments_init") f.sdk.payments.mockImplementation(() => { throw error; });
      else if (stage === "card_create") f.payments.card.mockRejectedValue(error);
      else f.card.attach.mockRejectedValue(error);
      f.start(); await flush();
      expect(f.input.onReady).not.toHaveBeenCalled();
      expect(f.input.onError).toHaveBeenCalledExactlyOnceWith({ stage, code: "WebSdkEmbedError" });
      expect(JSON.stringify(f.input.onError.mock.calls)).not.toContain("PRIVATE_CARD_DATA");
      expect(f.card.destroy).toHaveBeenCalledTimes(stage === "card_attach" ? 1 : 0);
    },
  );

  it("does not read or report arbitrary message, stack or payload fields", async () => {
    const readPrivate = vi.fn(() => { throw new Error("PRIVATE_TOKEN"); });
    const error = { name: "PRIVATE_TOKEN", get message() { return readPrivate(); },
      get stack() { return readPrivate(); }, get payload() { return readPrivate(); } };
    const f = mountFixture(); f.payments.card.mockRejectedValue(error);
    f.start(); await flush();
    expect(f.input.onError).toHaveBeenCalledExactlyOnceWith({ stage: "card_create", code: "square_sdk_error" });
    expect(readPrivate).not.toHaveBeenCalled();
  });

  it("contains a throwing error-name getter without leaking it or breaking recovery", async () => {
    const f = mountFixture();
    f.payments.card.mockRejectedValue({ get name() { throw new Error("PRIVATE_TOKEN"); } });
    f.start(); await flush();
    expect(f.input.onError).toHaveBeenCalledExactlyOnceWith({ stage: "card_create", code: "square_sdk_error" });
  });

  it("cancels during SDK load before creating any payments or card object", async () => {
    const loading = deferred<SquareGlobal>(); const f = mountFixture();
    f.input.loadSdk.mockReturnValue(loading.promise);
    const cancel = f.start(); cancel(); loading.resolve(f.sdk); await flush();
    expect(f.sdk.payments).not.toHaveBeenCalled();
    expect(f.input.onReady).not.toHaveBeenCalled(); expect(f.input.onError).not.toHaveBeenCalled();
  });

  it("destroys a late-created canceled card once without attaching it", async () => {
    const creating = deferred<SquareCard>(); const f = mountFixture();
    f.payments.card.mockReturnValue(creating.promise);
    const cancel = f.start(); await flush(); cancel(); cancel();
    expect(f.card.destroy).not.toHaveBeenCalled();
    creating.resolve(f.card); await flush();
    expect(f.card.attach).not.toHaveBeenCalled(); expect(f.card.destroy).toHaveBeenCalledTimes(1);
    expect(f.input.onReady).not.toHaveBeenCalled(); expect(f.input.onError).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("waits for pending attach to %s before destroying a canceled card", async outcome => {
    const attaching = deferred<void>(); const f = mountFixture();
    f.card.attach.mockReturnValue(attaching.promise);
    const cancel = f.start(); await flush(); cancel();
    expect(f.card.destroy).not.toHaveBeenCalled();
    if (outcome === "resolve") attaching.resolve(); else attaching.reject(new Error("stale-attachment"));
    await flush(); cancel();
    expect(f.card.destroy).toHaveBeenCalledTimes(1);
    expect(f.input.onReady).not.toHaveBeenCalled(); expect(f.input.onError).not.toHaveBeenCalled();
  });

  it("a replacement can become ready while an older canceled creation is pending", async () => {
    const creating = deferred<SquareCard>(); const old = mountFixture();
    old.payments.card.mockReturnValue(creating.promise);
    const cancelOld = old.start(); await flush(); cancelOld();
    const current = mountFixture({ selector: "#card-instance-2" }); const cancelCurrent = current.start(); await flush();
    expect(current.input.onReady).toHaveBeenCalledExactlyOnceWith(current.card);
    creating.resolve(old.card); await flush();
    expect(old.input.onReady).not.toHaveBeenCalled(); expect(old.card.destroy).toHaveBeenCalledTimes(1);
    expect(current.card.destroy).not.toHaveBeenCalled();
    cancelCurrent(); await flush(); expect(current.card.destroy).toHaveBeenCalledTimes(1);
  });

  it("a cleanup rejection cannot publish a stale card or extra customer error", async () => {
    const f = mountFixture(); f.card.destroy.mockRejectedValue(new Error("PRIVATE_PROVIDER_DETAILS"));
    const cancel = f.start(); await flush(); cancel(); await flush(); cancel();
    expect(f.card.destroy).toHaveBeenCalledTimes(1); expect(f.input.onError).not.toHaveBeenCalled();
  });
});
