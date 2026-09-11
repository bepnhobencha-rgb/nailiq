"use server";
import { inspectCardRecovery, loadCardRecoveryConsent } from "./bookingCardRecovery";
import { reconcileBookingCardSaveOperations } from "./reconcileBookingCardSaveOperations";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { durableRateLimitKey, isOverRateLimit } from "@/shared/lib/inAppRateLimit";

export async function recoverBookingCardAction(token: string, consent?: { accepted: true; policyVersion: string }): Promise<{ ok: boolean; managementToken?: string }> {
  if (typeof token !== "string" || token.length !== 36) return { ok: false };
  if (await isOverRateLimit(durableRateLimitKey("card-recovery", token), 6, 300, { failureMode: "block" })) return { ok: false };
  let inspected = await inspectCardRecovery(token);
  if (!inspected.ok || inspected.context.cancelled) return { ok: false };
  if (inspected.context.operationId) {
    // The token authorizes this exact booking only. No batch/other-tenant read.
    await reconcileBookingCardSaveOperations(1, inspected.context.operationId);
    inspected = await inspectCardRecovery(token);
  }
  if (!inspected.ok) return { ok: false };
  if (consent?.accepted === true && inspected.context.canRefreshConsent && inspected.context.operationId) {
    const policy = await loadCardRecoveryConsent(inspected.context);
    if (!policy || policy.version !== consent.policyVersion) return { ok: false };
    const { data, error } = await createServiceRoleClient().rpc("refresh_booking_card_recovery_consent" as never, {
      p_token_id: token, p_operation_id: inspected.context.operationId,
      p_consent_meta: { v:2,source:"booking_card_recovery",policyVersion:policy.version,feeCents:policy.feeCents,
        currency:policy.currency,scope:policy.scope,policyEn:policy.policyEn,policyVi:policy.policyVi },
    } as never);
    return { ok: !error && (data as { code?: string } | null)?.code === "reconciled_saved" };
  }
  if (!inspected.context.canRetry) return { ok: false };
  try {
    const { data, error } = await createServiceRoleClient().rpc("recover_booking_card_management" as never, { p_token_id: token } as never);
    const result = data as { ok?: boolean; token_id?: string } | null;
    return !error && result?.ok === true && typeof result.token_id === "string"
      ? { ok: true, managementToken: result.token_id } : { ok: false };
  } catch { return { ok: false }; }
}
