"use server";

import { createHash } from "node:crypto";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { durableRateLimitKey, isOverRateLimit } from "@/shared/lib/inAppRateLimit";
import { isValidCustomerName } from "@/shared/lib/nameFormat";
import { isValidIanaTimeZone } from "@/shared/booking/bookingManagementTime";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";

export type GroupRecoveryFailure = { ok: false; code: string };
export type GroupSlotRecovery = {
  ok: true;
  state: "available" | "pending" | "accepted" | "unavailable";
  eligible: boolean;
  reason: string | null;
  expiresAt: string | null;
  timezone: string;
};
export type GroupReplacementPreview = {
  ok: true;
  state: "available" | "accepted";
  salonName: string;
  serviceName: string;
  startTimeUtc: string;
  endTimeUtc: string;
  timezone: string;
  currency: string;
  priceCents: number;
  expiresAt: string;
  requiresCard: boolean;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/;
const failure = (code = "unavailable"): GroupRecoveryFailure => ({ ok: false, code });
const enabled = () => process.env.NAILIQ_GROUP_SLOT_RECOVERY === "true";
const writesEnabled = () => enabled() && process.env.NAILIQ_GROUP_SLOT_RECOVERY_WRITES !== "false";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
function code(value: unknown): string {
  return typeof value === "string" && ["feature_disabled", "card_protection_required", "contact_salon", "request_expired", "unavailable", "invalid_input", "slot_changed", "already_accepted", "different_guest_required"].includes(value) ? value : "unavailable";
}
async function invoke(name: string, args: Record<string, unknown>, authority: string, phase: "inspect" | "mutate"): Promise<Record<string, unknown>> {
  try {
    if (await isOverRateLimit(durableRateLimitKey("group-slot-recovery", authority, phase), phase === "inspect" ? 30 : 12, 300, { failureMode: "block" })) return failure("rate_limited");
    const { data, error } = await createServiceRoleClient().rpc(name as never, args as never);
    if (error || !data || typeof data !== "object" || Array.isArray(data)) return failure();
    return data as Record<string, unknown>;
  } catch { return failure(); }
}
function parsedFailure(row: Record<string, unknown>): GroupRecoveryFailure {
  return failure(row.code === "rate_limited" ? "rate_limited" : code(row.code));
}

/** Authority is the exact member-own cancellation capability, never a party URL. */
export async function loadGroupSlotRecovery(cancelToken: string): Promise<GroupSlotRecovery | GroupRecoveryFailure> {
  if (!enabled()) return failure("feature_disabled");
  if (typeof cancelToken !== "string" || !UUID.test(cancelToken)) return failure("invalid_input");
  const row = await invoke("inspect_group_slot_recovery", { p_capability_id: cancelToken }, cancelToken, "inspect");
  if (row.ok !== true) return parsedFailure(row);
  if (!["available", "pending", "accepted", "unavailable"].includes(String(row.state)) || typeof row.eligible !== "boolean" || (!text(row.timezone) || !isValidIanaTimeZone(row.timezone)) || (row.expires_at != null && !timestamp(row.expires_at))) return failure();
  return { ok: true, state: row.state as GroupSlotRecovery["state"], eligible: row.eligible, reason: row.reason == null ? null : code(row.reason), expiresAt: row.expires_at == null ? null : row.expires_at as string, timezone: row.timezone };
}

export async function startGroupReplacement(input: { cancelToken: string; requestId: string }): Promise<{ ok: true; token: string; expiresAt: string; idempotent: boolean } | GroupRecoveryFailure> {
  if (!writesEnabled()) return failure("feature_disabled");
  if (!input || typeof input.cancelToken !== "string" || typeof input.requestId !== "string" || !UUID.test(input.cancelToken) || !UUID.test(input.requestId)) return failure("invalid_input");
  // The private 122-bit capability and independently random request UUID give
  // deterministic response-loss recovery without storing a usable invite token.
  const token = hash(`nailiq-group-replacement-v1:${input.cancelToken.toLowerCase()}:${input.requestId.toLowerCase()}`);
  const row = await invoke("start_group_slot_replacement", { p_capability_id: input.cancelToken, p_request_id: input.requestId, p_token_hash: hash(token) }, input.cancelToken, "mutate");
  if (row.ok !== true) return parsedFailure(row);
  if (!timestamp(row.expires_at) || typeof row.idempotent !== "boolean") return failure();
  return { ok: true, token, expiresAt: row.expires_at, idempotent: row.idempotent };
}

export async function revokeGroupReplacement(input: { cancelToken: string; requestId: string }): Promise<{ ok: true } | GroupRecoveryFailure> {
  if (!writesEnabled()) return failure("feature_disabled");
  if (!input || typeof input.cancelToken !== "string" || typeof input.requestId !== "string" || !UUID.test(input.cancelToken) || !UUID.test(input.requestId)) return failure("invalid_input");
  const row = await invoke("revoke_group_slot_replacement", { p_capability_id: input.cancelToken, p_request_id: input.requestId }, input.cancelToken, "mutate");
  return row.ok === true ? { ok: true } : parsedFailure(row);
}

/** Scan-safe, minimal public display. No member identity or card metadata. */
export async function loadGroupReplacementPreview(token: string): Promise<GroupReplacementPreview | GroupRecoveryFailure> {
  if (!enabled()) return failure("feature_disabled");
  if (typeof token !== "string" || !TOKEN.test(token)) return failure("invalid_input");
  const row = await invoke("inspect_group_slot_replacement", { p_token_hash: hash(token) }, token, "inspect");
  if (row.ok !== true) return parsedFailure(row);
  if ((row.state !== "available" && row.state !== "accepted") || !text(row.salon_name) || !text(row.service_name) || (!text(row.timezone) || !isValidIanaTimeZone(row.timezone)) || !timestamp(row.start_time_utc) || !timestamp(row.end_time_utc) || Date.parse(row.end_time_utc) <= Date.parse(row.start_time_utc) || !timestamp(row.expires_at) || typeof row.price_cents !== "number" || !Number.isSafeInteger(row.price_cents) || row.price_cents < 0 || typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency) || row.requires_card !== false) return failure();
  return { ok: true, state: row.state, salonName: row.salon_name, serviceName: row.service_name, startTimeUtc: row.start_time_utc, endTimeUtc: row.end_time_utc, timezone: row.timezone, currency: row.currency, priceCents: row.price_cents, expiresAt: row.expires_at, requiresCard: false };
}

export async function acceptGroupReplacement(input: { token: string; requestId: string; name: string; phone: string; consentAccepted: boolean }): Promise<{ ok: true; state: "accepted"; idempotent: boolean } | GroupRecoveryFailure> {
  if (!writesEnabled()) return failure("feature_disabled");
  if (!input || typeof input.token !== "string" || !TOKEN.test(input.token) || typeof input.requestId !== "string" || !UUID.test(input.requestId) || typeof input.name !== "string" || !isValidCustomerName(input.name) || /[\r\n\t]/.test(input.name) || typeof input.phone !== "string" || input.phone.length > 32 || input.consentAccepted !== true) return failure("invalid_input");
  const phone = validateGuestPhone(input.phone);
  if (!phone.ok) return failure("invalid_input");
  const row = await invoke("accept_group_slot_replacement", { p_token_hash: hash(input.token), p_request_id: input.requestId, p_name: input.name.trim(), p_phone: phone.digits, p_consent: true }, input.token, "mutate");
  if (row.ok !== true) return parsedFailure(row);
  return row.state === "accepted" && typeof row.idempotent === "boolean" ? { ok: true, state: "accepted", idempotent: row.idempotent } : failure();
}
