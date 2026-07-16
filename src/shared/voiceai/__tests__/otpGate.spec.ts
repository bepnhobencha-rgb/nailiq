import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requirePhoneVerified } from "../otpGate";

const SALON = "salon-uuid-1";
const PHONE = "16045551234"; // canonical (E.164 digits, no +)

// Minimal chainable Supabase mock: .from().select().eq().eq().maybeSingle()
function mockDb(row: Record<string, unknown> | null): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: row }),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

const future = () => new Date(Date.now() + 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

describe("requirePhoneVerified — adaptive identity gate", () => {
  it("rejects an invalid phone before any DB read", async () => {
    const r = await requirePhoneVerified(mockDb(null), SALON, "123");
    expect(r).toMatchObject({ ok: false, error: "invalid_phone" });
  });

  it("allows via caller-ID when the carrier-verified From matches (no DB, no code)", async () => {
    // DB would return null (no session) — must not matter, caller-ID short-circuits.
    const r = await requirePhoneVerified(mockDb(null), SALON, PHONE, {
      callerVerifiedPhone: "+1 (604) 555-1234",
    });
    expect(r).toEqual({ ok: true, via: "caller_id" });
  });

  it("does NOT allow when caller-ID is for a DIFFERENT number", async () => {
    const r = await requirePhoneVerified(mockDb(null), SALON, PHONE, {
      callerVerifiedPhone: "16045559999",
    });
    expect(r).toMatchObject({ ok: false, error: "otp_required" });
  });

  it("requires OTP when there is no caller-ID and no session id (web default)", async () => {
    const r = await requirePhoneVerified(mockDb(null), SALON, PHONE);
    expect(r).toMatchObject({ ok: false, error: "otp_required" });
  });

  it("allows via a valid OTP session bound to the same phone", async () => {
    const r = await requirePhoneVerified(
      mockDb({ phone: PHONE, consumed_at: null, expires_at: future() }),
      SALON,
      PHONE,
      { otpSessionId: "sess-1" },
    );
    expect(r).toEqual({ ok: true, via: "otp" });
  });

  it("rejects a session for a DIFFERENT phone (cannot cancel someone else's booking)", async () => {
    const r = await requirePhoneVerified(
      mockDb({ phone: "16045559999", consumed_at: null, expires_at: future() }),
      SALON,
      PHONE,
      { otpSessionId: "sess-1" },
    );
    expect(r).toMatchObject({ ok: false, error: "otp_required" });
  });

  it("rejects a consumed session", async () => {
    const r = await requirePhoneVerified(
      mockDb({ phone: PHONE, consumed_at: new Date().toISOString(), expires_at: future() }),
      SALON,
      PHONE,
      { otpSessionId: "sess-1" },
    );
    expect(r).toMatchObject({ ok: false, error: "otp_required" });
  });

  it("rejects an expired session", async () => {
    const r = await requirePhoneVerified(
      mockDb({ phone: PHONE, consumed_at: null, expires_at: past() }),
      SALON,
      PHONE,
      { otpSessionId: "sess-1" },
    );
    expect(r).toMatchObject({ ok: false, error: "otp_required" });
  });

  it("rejects when no session row is found (wrong id or wrong salon)", async () => {
    const r = await requirePhoneVerified(mockDb(null), SALON, PHONE, {
      otpSessionId: "does-not-exist",
    });
    expect(r).toMatchObject({ ok: false, error: "otp_required" });
  });
});
