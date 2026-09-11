import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { isCardProtectionStatus, type CardProtectionStatus } from "./cardProtection";

export type CardRecoveryContext = {
  bookingId: string; salonId: string; protectionStatus: CardProtectionStatus;
  canRetry: boolean; canRefreshConsent: boolean; canVerifyExistingCard: boolean; cancelled: boolean; operationId: string | null; expiresAt: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function inspectCardRecovery(token: string): Promise<
  { ok: true; context: CardRecoveryContext } | { ok: false; code: "expired_or_revoked" | "management_unavailable" }
> {
  if (!UUID.test(token)) return { ok: false, code: "expired_or_revoked" };
  try {
    const { data, error } = await createServiceRoleClient({ timeoutMs: 4_000 }).rpc("inspect_booking_card_recovery" as never, { p_token_id: token } as never);
    const value = data as Record<string, unknown> | null;
    if (error) return { ok: false, code: "management_unavailable" };
    if (value?.ok !== true) return { ok: false, code: "expired_or_revoked" };
    if (!isCardProtectionStatus(value.protection_status) || typeof value.booking_id !== "string" ||
      !UUID.test(value.booking_id) || typeof value.salon_id !== "string" || !UUID.test(value.salon_id) ||
      typeof value.expires_at !== "string" || !Number.isFinite(Date.parse(value.expires_at)) ||
      typeof value.can_retry !== "boolean" || typeof value.cancelled !== "boolean" ||
      (value.operation_id != null && (typeof value.operation_id !== "string" || !UUID.test(value.operation_id)))) {
      return { ok: false, code: "management_unavailable" };
    }
    return { ok: true, context: { bookingId: value.booking_id, salonId: value.salon_id,
      protectionStatus: value.protection_status, canRetry: value.can_retry, canRefreshConsent: value.can_refresh_consent === true, canVerifyExistingCard: value.can_verify_existing_card === true, cancelled: value.cancelled,
      operationId: typeof value.operation_id === "string" ? value.operation_id : null, expiresAt: value.expires_at } };
  } catch { return { ok: false, code: "management_unavailable" }; }
}

export async function loadCardRecoveryConsent(context: CardRecoveryContext) {
  const db = createServiceRoleClient({ timeoutMs: 4_000 });
  const [{ data: booking, error: bookingError }, { data: salon, error: salonError }] = await Promise.all([
    db.from("bookings" as never).select("noshow_fee_cents,group_id").eq("id",context.bookingId).eq("salon_id",context.salonId).maybeSingle(),
    db.from("salons" as never).select("name,currency_code,cancellation_policy,noshow_group_whole_party").eq("id",context.salonId).maybeSingle(),
  ]);
  if (bookingError || salonError || !booking || !salon) return null;
  const b = booking as { noshow_fee_cents: number | null; group_id: string | null };
  const s = salon as { name: string; currency_code: string; cancellation_policy: { en?: string; vi?: string } | null; noshow_group_whole_party: boolean | null };
  const { buildNoShowConsentPolicy } = await import("@/shared/noshow/noShowConsentPolicy");
  const policy = buildNoShowConsentPolicy({ storedPolicy:s.cancellation_policy,salonName:s.name,feeCents:b.noshow_fee_cents ?? 0,
    currency:s.currency_code,scope:b.group_id && s.noshow_group_whole_party !== false ? "whole_party" : "booking_member" });
  return policy.ready && policy.version ? policy : null;
}
