import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  acknowledgeBookingManagementRequest,
  existingBookingManagementRequestId,
  pendingBookingManagementRequest,
  replacePendingBookingManagementRequestMaterial,
  replayExistingBookingManagementRequest,
  stableBookingManagementRequestId,
} from "../bookingManagementRequestId";

const values = new Map<string, string>();

describe("booking management browser request ids", () => {
  beforeEach(() => {
    values.clear();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });

  it("keeps one logical request id through response loss without storing the raw token", async () => {
    const intent = {
      action: "reschedule" as const,
      token: "11111111-1111-4111-8111-secret111111",
      material: "2099-08-20\n10:00 AM",
    };
    const first = await stableBookingManagementRequestId(intent);
    const replay = await stableBookingManagementRequestId(intent);
    expect(replay).toBe(first);
    expect([...values.keys()].join(" ")).not.toContain(intent.token);
    expect([...values.values()].some((value) => value.includes(first))).toBe(true);
    expect(await existingBookingManagementRequestId(intent)).toBe(first);
  });

  it("uses a new id for changed material and only rotates acknowledged intent", async () => {
    const firstIntent = {
      action: "reschedule" as const,
      token: "11111111-1111-4111-8111-111111111111",
      material: "2099-08-20\n10:00 AM",
    };
    const changedIntent = { ...firstIntent, material: "2099-08-20\n11:00 AM" };
    const first = await stableBookingManagementRequestId(firstIntent);
    const changed = await stableBookingManagementRequestId(changedIntent);
    expect(changed).not.toBe(first);
    await acknowledgeBookingManagementRequest(firstIntent);
    expect(await stableBookingManagementRequestId(firstIntent)).not.toBe(first);
    expect(await stableBookingManagementRequestId(changedIntent)).toBe(changed);
  });

  it("reload after a lost response POSTs the stored request id without rotating it", async () => {
    const intent = {
      action: "confirm" as const,
      token: "11111111-1111-4111-8111-111111111111",
    };
    const committedRequestId = await stableBookingManagementRequestId(intent);
    const execute = vi.fn(async () => ({
      acknowledged: true,
      value: { ok: true, idempotent: true },
    }));
    const replay = await replayExistingBookingManagementRequest(intent, execute);
    expect(replay).toEqual({
      requestId: committedRequestId,
      value: { ok: true, idempotent: true },
    });
    expect(execute).toHaveBeenCalledWith(committedRequestId);
    expect(await existingBookingManagementRequestId(intent)).toBeNull();
  });

  it("retains the same request id when a sequence quote adds its confirmed fingerprint", async () => {
    const initial = {
      action: "reschedule" as const,
      token: "11111111-1111-4111-8111-111111111111",
      material: JSON.stringify({ newStartUtc: "2099-08-20T17:00:00.000Z" }),
    };
    const requestId = await stableBookingManagementRequestId(initial);
    const confirmedMaterial = JSON.stringify({
      newStartUtc: "2099-08-20T17:00:00.000Z",
      expectedSequenceFingerprint: "a".repeat(64),
    });
    await expect(replacePendingBookingManagementRequestMaterial({
      ...initial,
      requestId,
      previousMaterial: initial.material,
      material: confirmedMaterial,
    })).resolves.toBe(true);
    await expect(pendingBookingManagementRequest(initial)).resolves.toEqual({
      requestId,
      material: confirmedMaterial,
    });
    await expect(existingBookingManagementRequestId({
      ...initial,
      material: confirmedMaterial,
    })).resolves.toBe(requestId);
    await expect(existingBookingManagementRequestId(initial)).resolves.toBeNull();
  });

  it("purges stale local replay metadata after the bounded recovery window", async () => {
    const intent = {
      action: "cancel" as const,
      token: "11111111-1111-4111-8111-111111111111",
    };
    await stableBookingManagementRequestId(intent);
    for (const [key, raw] of values) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      values.set(key, JSON.stringify({ ...parsed, createdAt: Date.now() - 25 * 60 * 60 * 1000 }));
    }
    expect(await existingBookingManagementRequestId(intent)).toBeNull();
    expect(values.size).toBe(0);
  });
});
