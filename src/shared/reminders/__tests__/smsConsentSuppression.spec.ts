import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));

import {
  loadSmsOutboundSuppression,
  recordInboundSmsConsent,
} from "../smsConsentSuppression";

const salonId = "11111111-1111-4111-8111-111111111111";
const hashKeyId = "22222222-2222-4222-8222-222222222222";
const eventId = "33333333-3333-4333-8333-333333333333";
const accountSid = `AC${"1".repeat(32)}`;
const messageSid = `SM${"2".repeat(32)}`;
const customerPhone = "+16045101234";
const senderPhone = "+17789073426";
const phoneHash = "3".repeat(64);
const materialFingerprint = "4".repeat(64);
const accountFingerprint = createHash("sha256").update(accountSid).digest("hex");
const senderFingerprint = createHash("sha256").update(senderPhone.slice(1)).digest("hex");

function ok(data: unknown) {
  return Promise.resolve({ data, error: null });
}

describe("durable SMS consent suppression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows dispatch only on one exact clear DB decision", async () => {
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "hash_sms_consent_phone") return ok({
        success: true, code: "hashed", contract_version: 1, phone_hash: phoneHash, hash_key_id: hashKeyId,
      });
      if (name === "load_sms_outbound_suppression") return ok({
        success: true, code: "clear", contract_version: 1, suppressed: false,
        reason: "clear", affirmative_consent_not_evaluated: true,
      });
      throw new Error(`unexpected RPC ${name}`);
    });
    await expect(loadSmsOutboundSuppression({ salonId, phone: customerPhone })).resolves.toEqual({
      suppressed: false,
      reason: "clear",
    });
  });

  it("preserves provider STOP and fails closed on unavailable or malformed truth", async () => {
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "hash_sms_consent_phone") return ok({
        success: true, code: "hashed", contract_version: 1, phone_hash: phoneHash, hash_key_id: hashKeyId,
      });
      return ok({
        success: true, code: "suppressed", contract_version: 1, suppressed: true,
        reason: "provider_stop", affirmative_consent_not_evaluated: true,
      });
    });
    await expect(loadSmsOutboundSuppression({ salonId, phone: customerPhone })).resolves.toEqual({
      suppressed: true,
      reason: "provider_stop",
    });

    mocks.rpc.mockReset().mockResolvedValue({ data: null, error: { message: "db unavailable" } });
    await expect(loadSmsOutboundSuppression({ salonId, phone: customerPhone })).resolves.toEqual({
      suppressed: true,
      reason: "consent_unavailable",
    });
  });

  it("claims and applies one signed provider STOP without storing raw phone/body", async () => {
    mocks.rpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === "sms_consent_provider_context") return ok({
        success: true, code: "loaded", contract_version: 1, provider: "twilio",
        provider_account_fingerprint: accountFingerprint,
        sender_fingerprint: senderFingerprint,
        hash_key_id: hashKeyId,
      });
      if (name === "hash_sms_consent_phone") return ok({
        success: true, code: "hashed", contract_version: 1,
        phone_hash: phoneHash, hash_key_id: hashKeyId,
      });
      if (name === "claim_sms_consent_event") {
        expect(args).toMatchObject({
          p_scope_kind: "provider_sender",
          p_event_kind: "provider_stop",
          p_source: "twilio_webhook",
          p_phone_hash: phoneHash,
          p_provider_account_fingerprint: accountFingerprint,
          p_sender_fingerprint: senderFingerprint,
          p_provider_event_id: messageSid,
          p_provider_message_sid: messageSid,
          p_occurred_at: null,
        });
        expect(JSON.stringify(args)).not.toContain(customerPhone);
        return ok({
          success: true, code: "claimed", contract_version: 1,
          event_id: eventId, status: "claimed", material_fingerprint: materialFingerprint,
        });
      }
      if (name === "record_sms_consent_event") return ok({
        success: true, code: "applied", contract_version: 1,
        effective_state: "suppressed",
      });
      throw new Error(`unexpected RPC ${name}`);
    });
    await expect(recordInboundSmsConsent({
      accountSid, messageSid, fromPhone: customerPhone, toPhone: senderPhone, optOutType: "STOP",
    })).resolves.toEqual({ ok: true, code: "applied", effectiveState: "suppressed", replay: false });
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "record_sms_consent_event")).toHaveLength(1);
  });

  it("returns exact already-applied replay without a second record mutation", async () => {
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "sms_consent_provider_context") return ok({
        success: true, code: "loaded", contract_version: 1, provider: "twilio",
        provider_account_fingerprint: accountFingerprint,
        sender_fingerprint: senderFingerprint,
        hash_key_id: hashKeyId,
      });
      if (name === "hash_sms_consent_phone") return ok({
        success: true, code: "hashed", contract_version: 1,
        phone_hash: phoneHash, hash_key_id: hashKeyId,
      });
      if (name === "claim_sms_consent_event") return ok({
        success: true, code: "already_applied", contract_version: 1,
        event_id: eventId, status: "applied", material_fingerprint: materialFingerprint,
        result: { success: true, code: "applied", contract_version: 1, effective_state: "clear" },
      });
      throw new Error(`unexpected RPC ${name}`);
    });
    await expect(recordInboundSmsConsent({
      accountSid, messageSid, fromPhone: customerPhone, toPhone: senderPhone, optOutType: "START",
    })).resolves.toEqual({ ok: true, code: "applied", effectiveState: "clear", replay: true });
    expect(mocks.rpc.mock.calls.some(([name]) => name === "record_sms_consent_event")).toBe(false);
  });

  it("rejects account/sender mismatch before claim", async () => {
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "sms_consent_provider_context") return ok({
        success: true, code: "loaded", contract_version: 1, provider: "twilio",
        provider_account_fingerprint: "9".repeat(64),
        sender_fingerprint: senderFingerprint,
        hash_key_id: hashKeyId,
      });
      if (name === "hash_sms_consent_phone") return ok({
        success: true, code: "hashed", contract_version: 1,
        phone_hash: phoneHash, hash_key_id: hashKeyId,
      });
      throw new Error(`unexpected RPC ${name}`);
    });
    await expect(recordInboundSmsConsent({
      accountSid, messageSid, fromPhone: customerPhone, toPhone: senderPhone, optOutType: "STOP",
    })).resolves.toEqual({ ok: false, code: "invalid_provider_event" });
    expect(mocks.rpc.mock.calls.some(([name]) => name === "claim_sms_consent_event")).toBe(false);
  });
});
