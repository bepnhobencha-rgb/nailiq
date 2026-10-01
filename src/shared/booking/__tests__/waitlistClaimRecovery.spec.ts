import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeBookingManagementRequest,
  existingBookingManagementRequestId,
  stableBookingManagementRequestId,
} from "../bookingManagementRequestId";
import { waitlistClaimRequestId } from "../waitlistClaimRecovery";

const TOKEN = "11111111-1111-4111-8111-111111111111";
const intent = { action: "waitlist_claim" as const, token: TOKEN };
const values = new Map<string, string>();

describe("waitlist claim reload recovery", () => {
  beforeEach(() => {
    values.clear();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("never mints a request for an unavailable offer in a fresh browser", async () => {
    const create = vi.spyOn(crypto, "randomUUID");
    await expect(waitlistClaimRequestId(TOKEN, false)).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(values.size).toBe(0);
    create.mockRestore();
  });

  it("creates one intent only when the offer is available", async () => {
    const first = await waitlistClaimRequestId(TOKEN, true);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    await expect(waitlistClaimRequestId(TOKEN, true)).resolves.toBe(first);
    expect(values.size).toBe(2);
    expect([...values].flat().join(" ")).not.toContain(TOKEN);
  });

  it("reuses the committed intent after reload even if inspection says unavailable", async () => {
    const committed = await stableBookingManagementRequestId(intent);
    const before = [...values];
    await expect(waitlistClaimRequestId(TOKEN, false)).resolves.toBe(committed);
    expect([...values]).toEqual(before);
  });

  it("retains the intent through repeated response loss until an acknowledgement", async () => {
    const committed = await stableBookingManagementRequestId(intent);
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(waitlistClaimRequestId(TOKEN, false)).resolves.toBe(committed);
    }
    await acknowledgeBookingManagementRequest(intent);
    await expect(waitlistClaimRequestId(TOKEN, false)).resolves.toBeNull();
    expect(values.size).toBe(0);
  });

  it("cannot recover a different token's intent", async () => {
    const committed = await stableBookingManagementRequestId(intent);
    await expect(waitlistClaimRequestId("22222222-2222-4222-8222-222222222222", false)).resolves.toBeNull();
    await expect(existingBookingManagementRequestId(intent)).resolves.toBe(committed);
  });

  it("fails closed on stale or malformed metadata without rotating a request", async () => {
    for (const metadata of [
      { requestId: "invalid", createdAt: Date.now() },
      { requestId: "33333333-3333-4333-8333-333333333333", createdAt: Date.now() - 25 * 60 * 60 * 1000 },
    ]) {
      await stableBookingManagementRequestId(intent);
      for (const key of values.keys()) values.set(key, JSON.stringify(metadata));
      await expect(waitlistClaimRequestId(TOKEN, false)).resolves.toBeNull();
      expect(values.size).toBe(0);
    }
  });

  it("does not replace a denied storage lookup with a new request", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("storage denied"); } });
    await expect(waitlistClaimRequestId(TOKEN, false)).rejects.toThrow("storage denied");
    await expect(waitlistClaimRequestId(TOKEN, true)).rejects.toThrow("storage denied");
  });
});
