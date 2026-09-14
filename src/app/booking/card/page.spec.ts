import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  token: "synthetic-token",
  effect: null as (() => void) | null,
  value: { phase: "loading" } as { phase: string; code?: string },
  pending: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams({ token: state.token }) }));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual,
    useEffect: (effect: () => void) => { state.effect = effect; },
    useState: () => [state.value, (value: typeof state.value) => { state.value = value; }],
  };
});
vi.mock("@/shared/booking/bookingManagementRequestId", () => ({
  pendingBookingManagementRequest: state.pending,
  acknowledgeBookingManagementRequest: vi.fn(),
  stableBookingManagementRequestId: vi.fn(),
}));

import Page from "./page";

function managerElement() {
  const child = Page().props.children as React.ReactElement;
  return (child.type as () => React.ReactElement<{ token: string }>)();
}

function renderManager() {
  const child = managerElement();
  return (child.type as (props: { token: string }) => React.ReactElement)(child.props);
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (React.isValidElement<{ children?: unknown }>(value)) return textOf(value.props.children);
  return "";
}

describe("saved card management read failures", () => {
  beforeEach(() => {
    state.value = { phase: "loading" };
    state.token = "synthetic-token";
    state.effect = null;
    state.pending.mockReset().mockResolvedValue(null);
    vi.stubGlobal("React", React);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(["token_consumed", "expired_or_revoked", "invalid_token"])("%s gives a new-link instruction without suggesting a removal", async (code) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: false, code }, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    renderManager();
    state.effect!();
    await vi.waitFor(() => expect(state.value.phase).toBe("error"));
    const copy = textOf(renderManager());
    expect(copy).toContain("request a new secure link");
    expect(copy).toContain("xin liên kết an toàn mới");
    expect(copy).not.toContain("We could not load");
    expect(copy).not.toContain("confirm that your card was removed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain("/api/booking/card-info?");
  });

  it("retains reload guidance for a transient inspection outage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: false, code: "management_unavailable" }, { status: 503 })));
    renderManager();
    state.effect!();
    await vi.waitFor(() => expect(state.value.phase).toBe("error"));
    expect(textOf(renderManager())).toContain("We could not load your card information");
    expect(textOf(renderManager())).not.toContain("request a new secure link");
  });

  it("keeps an unresolved removal result instead of replacing it with a card-info read", async () => {
    state.pending.mockResolvedValue({ requestId: "synthetic-request", material: "a".repeat(64) });
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: false, code: "remove_unknown" }, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    renderManager();
    state.effect!();
    await vi.waitFor(() => expect(state.value.phase).toBe("error"));
    expect(textOf(renderManager())).toContain("cannot yet confirm that your card was removed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/booking/remove-card");
  });

  it("remounts for a changed token and ignores a previous token's delayed read", async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn().mockReturnValue(new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal("fetch", fetch);
    const original = managerElement();
    renderManager();
    const cleanup = state.effect!() as unknown as () => void;
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    state.token = "different-synthetic-token";
    const next = managerElement();
    expect(next.type).toBe(original.type);
    expect(next.key).not.toBe(original.key);
    expect(next.props.token).toBe(state.token);
    // React unmounts the previous keyed manager and runs its effect cleanup.
    cleanup();
    resolve(Response.json({ ok: true, hasCard: true, last4: "1111", brandColor: "#184A56", themeMode: "dark" }));
    await new Promise((done) => setTimeout(done, 0));
    expect(state.value.phase).toBe("loading");
  });

  async function loadCard(proof: Record<string, unknown>) {
    const fetch = vi.fn().mockResolvedValue(Response.json({
      ok: true, salonName: "Synthetic Salon", brandColor: "#184A56", themeMode: "dark",
      hasCard: true, brand: "VISA", last4: "1111", feeLabel: "10.00 CAD", cardFingerprint: "a".repeat(64),
      ...proof,
    }));
    vi.stubGlobal("fetch", fetch);
    renderManager();
    state.effect!();
    await vi.waitFor(() => expect(state.value.phase).toBe("view"));
    return { html: renderToStaticMarkup(renderManager()), fetch };
  }

  it("shows active protection and policy fee only with an affirmative saved receipt", async () => {
    const { html } = await loadCard({ protectionStatus: "saved", protectionActive: true });
    expect(html).toContain("Card protection active");
    expect(html).toContain("10.00 CAD");
    expect(html).toContain('data-testid="remove-card-btn"');
    expect(html).not.toContain("/booking/save-card?");
  });

  it.each([
    { protectionStatus: "manual_review", protectionActive: false },
    { protectionStatus: "reconciliation_pending", protectionActive: false },
    { protectionStatus: "awaiting_card", protectionActive: false },
    { protectionStatus: "saving", protectionActive: false },
    { protectionStatus: "retry_required", protectionActive: false },
    { protectionStatus: "saved", protectionActive: false },
    { protectionStatus: "manual_review", protectionActive: true },
    { protectionActive: true },
    {},
  ])("does not promise protection or a chargeable fee for incomplete proof %j", async (proof) => {
    const { html, fetch } = await loadCard(proof);
    expect(html).toContain("Card protection is not active");
    expect(html).not.toContain("Card protection active");
    expect(html).not.toContain("10.00 CAD");
    expect(html).not.toContain("Your saved card");
    expect(html).toContain('href="/booking/save-card?token=synthetic-token"');
    expect(html).toContain('data-testid="remove-card-btn"');
    expect(html).toContain("1111");
    expect(html).toContain("--booking-text:#ffffff");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain("/api/booking/card-info?");
  });

  it("offers recovery without a removal action when no card exists", async () => {
    const { html } = await loadCard({ hasCard: false, protectionStatus: "awaiting_card", protectionActive: false });
    expect(html).toContain("No card is on file");
    expect(html).toContain("/booking/save-card?token=synthetic-token");
    expect(html).not.toContain('data-testid="remove-card-btn"');
    expect(html).not.toContain("10.00 CAD");
  });

  it("does not ask for protection or a fee when a card is not required", async () => {
    const { html } = await loadCard({ protectionStatus: "not_required", protectionActive: false });
    expect(html).toContain("No card required for this appointment");
    expect(html).not.toContain("10.00 CAD");
    expect(html).not.toContain("/booking/save-card?");
    expect(html).toContain('data-testid="remove-card-btn"');
  });
});
