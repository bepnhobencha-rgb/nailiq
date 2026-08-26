import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  acknowledgePublicDepositReplayIdentity,
  stablePublicDepositReplayIdentity,
} from "../publicDepositReplayIdentity";

describe("public deposit replay identity", () => {
  beforeEach(() => {
    const rows = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => rows.get(key) ?? null,
      setItem: (key: string, value: string) => rows.set(key, value),
      removeItem: (key: string) => rows.delete(key),
    });
    vi.stubGlobal("crypto", globalThis.crypto);
  });

  it("reuses both identities until the bound booking is acknowledged", async () => {
    const first = await stablePublicDepositReplayIdentity("safe-canonical-intent");
    expect(await stablePublicDepositReplayIdentity("safe-canonical-intent")).toEqual(first);
    await acknowledgePublicDepositReplayIdentity("safe-canonical-intent");
    const next = await stablePublicDepositReplayIdentity("safe-canonical-intent");
    expect(next.bookingRequestId).not.toBe(first.bookingRequestId);
    expect(next.paymentRequestId).not.toBe(first.paymentRequestId);
  });
});
