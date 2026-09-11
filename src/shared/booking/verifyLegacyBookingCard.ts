import "server-only";
import { randomUUID } from "node:crypto";
import { cardFailure, safeCardFailure, type CardFailureStage } from "@/shared/integrations/payments/cardDeliveryFailure";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getSquareConfig, readSquareCardById } from "@/shared/integrations/square/client";
import { buildNoShowConsentPolicy } from "@/shared/noshow/noShowConsentPolicy";
import { isCardCapturePaused } from "./cardCapturePause";

type Snapshot = {
  salon_id: string; card_id: string; customer_id: string; merchant_id: string; environment: string;
  salon_name: string; currency: string; fee_cents: number; scope: "whole_party" | "booking_member";
  stored_policy: { en?: string; vi?: string } | null;
};

/** This path verifies an existing binding. It never searches for customers,
 * tokenizes, creates or disables a card. The short completion transaction
 * compares the original snapshot so concurrent changes cannot be certified. */
export async function verifyLegacyBookingCard(token: string, policyVersion: string): Promise<{ ok: boolean }> {
  if (isCardCapturePaused()) return { ok: false };
  const db = createServiceRoleClient();
  const checkId = randomUUID();
  let stage: CardFailureStage = "database_completion";
  let bookingId: string | undefined;
  async function record(code: string, outcome: string, error?: unknown) {
    const safe = safeCardFailure(error, stage);
    // GET-only diagnostics use a narrower allowlist than card mutations.
    const allowedCodes = ["UNAUTHORIZED","ACCESS_TOKEN_EXPIRED","ACCESS_TOKEN_REVOKED","FORBIDDEN",
      "INSUFFICIENT_SCOPES","RATE_LIMITED","INTERNAL_SERVER_ERROR","SERVICE_UNAVAILABLE","BAD_REQUEST",
      "INVALID_REQUEST_ERROR","INVALID_VALUE","MISSING_REQUIRED_PARAMETER","NOT_FOUND","CONFLICT"];
    const allowedCategories = ["API_ERROR","AUTHENTICATION_ERROR","INVALID_REQUEST_ERROR","RATE_LIMIT_ERROR"];
    const diagnostic = { p_token_id: token, p_check_id: checkId, p_stage: stage, p_code: code,
      p_http_status: safe.httpStatus, p_square_codes: safe.squareCodes.filter(value => allowedCodes.includes(value)),
      p_square_categories: safe.squareCategories.filter(value => allowedCategories.includes(value)), p_outcome: outcome };
    try {
      const result = await db.rpc("record_booking_legacy_card_check" as never, diagnostic as never);
      if (!result.error && (result.data as {ok?:boolean}|null)?.ok === true) return;
    } catch { /* A database outage can also prevent durable diagnostics. */ }
    console.warn("[legacy-card-check]", { checkId, bookingId, provider: "square", stage, code,
      httpStatus: safe.httpStatus, outcome, at: new Date().toISOString() });
  }
  try {
    const inspected = await db.rpc("inspect_booking_legacy_card" as never, { p_token_id: token } as never);
    const value = inspected.data as { ok?: boolean; snapshot?: Snapshot } | null;
    if (inspected.error || value?.ok !== true || !value.snapshot) return { ok: false };
    const snapshot = value.snapshot;
    bookingId = (snapshot as Snapshot & { booking_id?: string }).booking_id;
    const policy = buildNoShowConsentPolicy({ storedPolicy: snapshot.stored_policy, salonName: snapshot.salon_name,
      feeCents: snapshot.fee_cents, currency: snapshot.currency, scope: snapshot.scope });
    if (!policy.ready || !policy.version || policy.version !== policyVersion) return { ok: false };
    stage = "configuration";
    const cfg = await getSquareConfig(db, snapshot.salon_id);
    if (!cfg || cfg.merchantId !== snapshot.merchant_id || cfg.environment !== snapshot.environment) {
      throw cardFailure("configuration", "square_config_unavailable", "safe_retry");
    }
    stage = "reconciliation";
    const card = await readSquareCardById(cfg, snapshot.card_id, snapshot.customer_id);
    stage = "database_completion";
    const completed = await db.rpc("confirm_booking_legacy_card_verification" as never, {
      p_token_id: token, p_expected_snapshot: snapshot, p_read_at: new Date().toISOString(),
      p_receipt: { card_id: card.cardId, customer_id: card.customerId, card_brand: card.brand,
        card_last4: card.last4, merchant_id: card.merchantId, environment: cfg.environment, enabled: card.enabled },
      p_consent_meta: { v: 2, source: "legacy_card_fresh_consent", receiptSource: "existing_card_read",
        policyVersion: policy.version, feeCents: policy.feeCents, currency: policy.currency, scope: policy.scope,
        policyEn: policy.policyEn, policyVi: policy.policyVi },
    } as never);
    const result = completed.data as { ok?: boolean; code?: string } | null;
    if (completed.error) throw cardFailure("database_completion", "database_completion_uncertain", "reconcile_first");
    if (result?.ok !== true) {
      await record("verification_changed", "changed");
      return { ok: false };
    }
    await record("legacy_card_verified", "found");
    return { ok: true };
  } catch (error) {
    // A failed GET or lost DB response never authorizes creating/replacing a
    // card. A replay only reads that card again and completes idempotently.
    const failure = safeCardFailure(error, stage);
    const invalid = stage === "reconciliation" && failure.code === "reconciliation_invalid_card";
    await record(stage === "configuration" ? "square_config_unavailable" :
      stage === "database_completion" ? "database_completion_uncertain" : invalid ? "reconciliation_invalid_card" : "reconciliation_read_failed",
      stage === "configuration" ? "config_unavailable" : stage === "database_completion" ? "completion_uncertain" : invalid ? "invalid_card" : "read_failed", error);
    return { ok: false };
  }
}
