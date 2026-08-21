import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

import {
  claimWaitlistSlot,
  loadWaitlistClaimPreview,
  parseWaitlistClaimToken,
} from "@/shared/booking/waitlistClaim";

const TOKEN = "123e4567-e89b-42d3-a456-426614174000";
const REQUEST_ID = "223e4567-e89b-42d3-a456-426614174000";

function previewDb(data: unknown, error: unknown = null) {
  const rpc = vi.fn(async () => ({ data, error }));
  return { rpc };
}

describe("waitlist claim boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("scanner/page preview selects lifecycle facts and performs zero claim RPC mutations", async () => {
    const db = previewDb({ ok: true, code: "available", context: { salon_id: "private" } });
    mocks.createServiceRoleClient.mockReturnValue(db);

    await expect(loadWaitlistClaimPreview(TOKEN)).resolves.toEqual({ state: "available" });
    expect(db.rpc).toHaveBeenCalledWith("inspect_waitlist_claim_capability", { p_token_id: TOKEN });
  });

  it.each([
    null,
    { ok: false, code: "unavailable" },
    { ok: false, code: "unavailable", internal: "claimed" },
  ])("keeps invalid, expired, and claimed preview states generic", async (row) => {
    const db = previewDb(row);
    mocks.createServiceRoleClient.mockReturnValue(db);
    await expect(loadWaitlistClaimPreview(TOKEN)).resolves.toEqual({ state: "unavailable" });
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });

  it("an explicit claim calls the existing RPC exactly once and strips returned PII", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        ok: true,
        code: "claimed",
        outcome: "booked",
        idempotent: false,
        client_name: "Must not escape",
        client_phone: "+15555550100",
        client_email: "secret@example.test",
        booking_id: "booking-secret",
      },
      error: null,
    }));
    mocks.createServiceRoleClient.mockReturnValue({ rpc });

    const result = await claimWaitlistSlot(TOKEN, REQUEST_ID);
    expect(result).toEqual({ ok: true, outcome: "booked" });
    expect(JSON.stringify(result)).not.toMatch(/Must not escape|15555550100|secret@|booking-secret/);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("claim_waitlist_with_management_capability", {
      p_token_id: TOKEN,
      p_request_id: REQUEST_ID,
    });
  });

  it("treats a changed/claimed replay as unavailable without retrying", async () => {
    const rpc = vi.fn(async () => ({ data: { ok: false, code: "idempotency_mismatch" }, error: null }));
    mocks.createServiceRoleClient.mockReturnValue({ rpc });

    await expect(claimWaitlistSlot(TOKEN, REQUEST_ID)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed capability tokens before constructing a service client", async () => {
    expect(parseWaitlistClaimToken("not-a-token")).toBeNull();
    await expect(loadWaitlistClaimPreview("not-a-token")).resolves.toEqual({ state: "unavailable" });
    await expect(claimWaitlistSlot("not-a-token", REQUEST_ID)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });
});
