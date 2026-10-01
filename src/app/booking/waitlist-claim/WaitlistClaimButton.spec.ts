import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Node unit coverage of the actual component's handlers/effect. Real React
// hydration, keyboard input and DB commit/reload are verified separately in B54.
const hooks = vi.hoisted(() => ({
  value: null as { kind: string } | null,
  ref: { current: false },
  effect: null as (() => void | (() => void)) | null,
}));
vi.mock("react", async () => ({
  ...await vi.importActual<typeof import("react")>("react"),
  useState: (initial: { kind: string }) => [hooks.value ??= initial, (value: { kind: string }) => { hooks.value = value; }],
  useRef: () => hooks.ref,
  useEffect: (effect: () => void | (() => void)) => { hooks.effect = effect; },
}));

import { WaitlistClaimButton } from "./WaitlistClaimButton";
import { stableBookingManagementRequestId, existingBookingManagementRequestId } from "@/shared/booking/bookingManagementRequestId";

const TOKEN = "11111111-1111-4111-8111-111111111111";
const intent = { action: "waitlist_claim" as const, token: TOKEN };
const values = new Map<string, string>();

function render(isAvailable: boolean) {
  return WaitlistClaimButton({ token: TOKEN, isAvailable });
}
function action(element: React.ReactElement): () => Promise<void> {
  const props = element.props as { onClick?: () => Promise<void>; retry?: () => Promise<void>; children?: unknown };
  if (props.onClick) return props.onClick;
  if (props.retry) return props.retry;
  for (const child of React.Children.toArray(props.children as React.ReactNode)) {
    if (React.isValidElement(child)) {
      try { return action(child); } catch { /* Continue through non-interactive children. */ }
    }
  }
  throw new Error("No claim action");
}

describe("waitlist claim recovery component handlers", () => {
  beforeEach(() => {
    hooks.value = null;
    hooks.ref.current = false;
    hooks.effect = null;
    values.clear();
    vi.stubGlobal("React", React);
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, outcome: "booked" })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("mount offers recovery for an old intent without making a POST", async () => {
    await stableBookingManagementRequestId(intent);
    render(false);
    hooks.effect!();
    await vi.waitFor(() => expect(hooks.value?.kind).toBe("recovery"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fresh browser stays unavailable and cannot mint or POST a recovery", async () => {
    render(false);
    hooks.effect!();
    await vi.waitFor(() => expect(values.size).toBe(0));
    expect(hooks.value?.kind).toBe("unavailable");
    expect(() => action(render(false))).toThrow("No claim action");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("explicit recovery posts exactly the old ID and acknowledges only success", async () => {
    const requestId = await stableBookingManagementRequestId(intent);
    render(false);
    hooks.effect!();
    await vi.waitFor(() => expect(hooks.value?.kind).toBe("recovery"));
    await action(render(false))();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({ token: TOKEN, requestId });
    expect(hooks.value?.kind).toBe("booked");
    await expect(existingBookingManagementRequestId(intent)).resolves.toBeNull();
  });

  it.each(["transport", "http503", "malformed-success", "unknown-outcome"])("%s retains the intent for a later explicit retry", async (failure) => {
    const requestId = await stableBookingManagementRequestId(intent);
    vi.mocked(fetch).mockImplementationOnce(async () => {
      if (failure === "transport") throw new Error("synthetic response loss");
      if (failure === "http503") return Response.json({ ok: false }, { status: 503 });
      if (failure === "unknown-outcome") return Response.json({ ok: true, outcome: "unknown" });
      return new Response("not json", { status: 200 });
    });
    hooks.value = { kind: "recovery" };
    await action(render(false))();
    expect(hooks.value?.kind).toBe("error");
    await expect(existingBookingManagementRequestId(intent)).resolves.toBe(requestId);
    await action(render(false))();
    const ids = vi.mocked(fetch).mock.calls.map(([, options]) => JSON.parse(options!.body as string).requestId);
    expect(ids).toEqual([requestId, requestId]);
    expect(hooks.value?.kind).toBe("booked");
  });

  it("rapid repeated activation shares the in-flight guard", async () => {
    await stableBookingManagementRequestId(intent);
    hooks.value = { kind: "recovery" };
    let release!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
    const submit = action(render(false));
    const first = submit();
    await submit();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(hooks.ref.current).toBe(true);
    release(Response.json({ ok: true, outcome: "claimed" }));
    await first;
    expect(hooks.value?.kind).toBe("claimed");
    expect(hooks.ref.current).toBe(false);
  });

  it.each([400, 409])("terminal %s stays unavailable rather than claiming success", async (status) => {
    await stableBookingManagementRequestId(intent);
    hooks.value = { kind: "recovery" };
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: false }, { status }));
    await action(render(false))();
    expect(hooks.value?.kind).toBe("unavailable");
    await expect(existingBookingManagementRequestId(intent)).resolves.toBeNull();
  });

  it("unmount ignores a late local metadata lookup", async () => {
    await stableBookingManagementRequestId(intent);
    render(false);
    const cleanup = hooks.effect!();
    if (typeof cleanup !== "function") throw new Error("Missing effect cleanup");
    cleanup();
    await existingBookingManagementRequestId(intent);
    expect(hooks.value?.kind).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("missing metadata at activation never falls back to a fresh claim", async () => {
    hooks.value = { kind: "recovery" };
    await action(render(false))();
    expect(hooks.value?.kind).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
    expect(values.size).toBe(0);
  });
});
