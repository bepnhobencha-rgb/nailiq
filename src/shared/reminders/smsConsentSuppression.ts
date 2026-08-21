import "server-only";

import { createHash } from "node:crypto";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TWILIO_ACCOUNT_RE = /^AC[0-9A-Fa-f]{32}$/;
const TWILIO_MESSAGE_RE = /^(SM|MM)[0-9A-Fa-f]{32}$/;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  const candidate = Array.isArray(value) && value.length === 1 ? value[0] : value;
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as JsonObject
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stableUuid(material: string): string {
  const bytes = createHash("sha256").update(material, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function rpc(name: string, args?: Record<string, unknown>): Promise<JsonObject | null> {
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(name as never, (args ?? {}) as never);
  if (error) return null;
  return object(data);
}

type ProviderContext = {
  accountFingerprint: string;
  senderFingerprint: string;
  hashKeyId: string;
};

async function providerContext(): Promise<ProviderContext | null> {
  const row = await rpc("sms_consent_provider_context");
  const accountFingerprint = string(row?.provider_account_fingerprint);
  const senderFingerprint = string(row?.sender_fingerprint);
  const hashKeyId = string(row?.hash_key_id);
  if (
    row?.success !== true || row.code !== "loaded" || row.contract_version !== 1 ||
    row.provider !== "twilio" || !accountFingerprint || !SHA256_RE.test(accountFingerprint) ||
    !senderFingerprint || !SHA256_RE.test(senderFingerprint) ||
    !hashKeyId || !UUID_RE.test(hashKeyId)
  ) return null;
  return { accountFingerprint, senderFingerprint, hashKeyId };
}

async function hashPhone(phone: string): Promise<{ phoneHash: string; hashKeyId: string } | null> {
  const canonical = toCanonicalPhone(phone);
  if (!canonical) return null;
  const row = await rpc("hash_sms_consent_phone", { p_phone: canonical });
  const phoneHash = string(row?.phone_hash);
  const hashKeyId = string(row?.hash_key_id);
  if (
    row?.success !== true || row.code !== "hashed" || row.contract_version !== 1 ||
    !phoneHash || !SHA256_RE.test(phoneHash) || !hashKeyId || !UUID_RE.test(hashKeyId)
  ) return null;
  return { phoneHash, hashKeyId };
}

export type SmsSuppressionDecision = {
  suppressed: boolean;
  reason:
    | "clear"
    | "provider_stop"
    | "salon_suppression"
    | "salon_sms_disabled"
    | "consent_unavailable";
};

/** Fail-closed, PII-minimized suppression check immediately before dispatch. */
export async function loadSmsOutboundSuppression(input: {
  salonId: string;
  phone: string;
}): Promise<SmsSuppressionDecision> {
  if (!UUID_RE.test(input.salonId)) return { suppressed: true, reason: "consent_unavailable" };
  const hashed = await hashPhone(input.phone);
  if (!hashed) return { suppressed: true, reason: "consent_unavailable" };
  const row = await rpc("load_sms_outbound_suppression", {
    p_salon_id: input.salonId,
    p_phone_hash: hashed.phoneHash,
    p_hash_key_id: hashed.hashKeyId,
  });
  if (
    row?.success !== true || row.contract_version !== 1 ||
    row.affirmative_consent_not_evaluated !== true ||
    typeof row.suppressed !== "boolean"
  ) return { suppressed: true, reason: "consent_unavailable" };
  if (row.code === "clear" && row.suppressed === false && row.reason === "clear") {
    return { suppressed: false, reason: "clear" };
  }
  if (row.code === "suppressed" && row.suppressed === true) {
    if (row.reason === "provider_stop" || row.reason === "salon_suppression" || row.reason === "salon_sms_disabled") {
      return { suppressed: true, reason: row.reason };
    }
  }
  return { suppressed: true, reason: "consent_unavailable" };
}

export type RecordedSmsConsent =
  | { ok: true; code: "applied" | "stale_ignored"; effectiveState: "suppressed" | "clear"; replay: boolean }
  | { ok: false; code: "invalid_provider_event" | "consent_unavailable" | "consent_conflict" };

function parseAppliedResult(value: unknown): Omit<Extract<RecordedSmsConsent, { ok: true }>, "replay"> | null {
  const row = object(value);
  if (
    row?.success !== true || row.contract_version !== 1 ||
    (row.code !== "applied" && row.code !== "stale_ignored") ||
    (row.effective_state !== "suppressed" && row.effective_state !== "clear")
  ) return null;
  return { ok: true, code: row.code, effectiveState: row.effective_state };
}

/** Persist a signed Twilio STOP/START event; exact MessageSid replay is write-free. */
export async function recordInboundSmsConsent(input: {
  accountSid: string;
  messageSid: string;
  fromPhone: string;
  toPhone: string;
  optOutType: "STOP" | "START";
}): Promise<RecordedSmsConsent> {
  const accountSid = input.accountSid.trim().toUpperCase();
  const messageSid = input.messageSid.trim().toUpperCase();
  const fromPhone = toCanonicalPhone(input.fromPhone);
  const toPhone = toCanonicalPhone(input.toPhone);
  if (
    !TWILIO_ACCOUNT_RE.test(accountSid) || !TWILIO_MESSAGE_RE.test(messageSid) ||
    !fromPhone || !toPhone
  ) return { ok: false, code: "invalid_provider_event" };

  const [context, hashed] = await Promise.all([
    providerContext(),
    hashPhone(fromPhone),
  ]);
  if (!context || !hashed || context.hashKeyId !== hashed.hashKeyId) {
    return { ok: false, code: "consent_unavailable" };
  }
  const accountFingerprint = createHash("sha256").update(accountSid, "utf8").digest("hex");
  const senderFingerprint = createHash("sha256").update(toPhone, "utf8").digest("hex");
  if (
    accountFingerprint !== context.accountFingerprint ||
    senderFingerprint !== context.senderFingerprint
  ) return { ok: false, code: "invalid_provider_event" };

  const requestId = stableUuid(`sms-consent:twilio:${accountSid}:${messageSid}`);
  const claim = await rpc("claim_sms_consent_event", {
    p_request_id: requestId,
    p_scope_kind: "provider_sender",
    p_event_kind: input.optOutType === "STOP" ? "provider_stop" : "provider_start",
    p_source: "twilio_webhook",
    p_origin_salon_id: null,
    p_phone_hash: hashed.phoneHash,
    p_hash_key_id: hashed.hashKeyId,
    p_provider_account_fingerprint: accountFingerprint,
    p_sender_fingerprint: senderFingerprint,
    p_provider_event_id: messageSid,
    p_provider_message_sid: messageSid,
    p_occurred_at: null,
  });
  const eventId = string(claim?.event_id);
  const materialFingerprint = string(claim?.material_fingerprint);
  if (
    claim?.success !== true || claim.contract_version !== 1 ||
    !eventId || !UUID_RE.test(eventId) ||
    !materialFingerprint || !SHA256_RE.test(materialFingerprint)
  ) return { ok: false, code: claim?.code?.toString().includes("conflict") ? "consent_conflict" : "consent_unavailable" };

  if (claim.code === "already_applied") {
    const applied = parseAppliedResult(claim.result);
    return applied ? { ...applied, replay: true } : { ok: false, code: "consent_unavailable" };
  }
  if (claim.code !== "claimed" && claim.code !== "claim_replay" && claim.code !== "provider_event_replay") {
    return { ok: false, code: "consent_unavailable" };
  }

  const recorded = await rpc("record_sms_consent_event", {
    p_event_id: eventId,
    p_request_id: requestId,
    p_material_fingerprint: materialFingerprint,
  });
  const applied = parseAppliedResult(recorded);
  return applied
    ? { ...applied, replay: claim.code !== "claimed" }
    : { ok: false, code: recorded?.code?.toString().includes("conflict") ? "consent_conflict" : "consent_unavailable" };
}
