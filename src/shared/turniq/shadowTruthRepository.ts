import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import type {
  TurnIqShadowComparisonRow,
  TurnIqShadowDecisionRow,
  TurnIqShadowTruthRepository,
} from "@/shared/turniq/shadowTruth";

type DatabaseError = { code?: string; message?: string } | null;

function isUniqueViolation(error: DatabaseError): boolean {
  return error?.code === "23505";
}

async function existingDecision(
  salonId: string,
  observationFingerprint: string,
): Promise<{ id: string; inserted: false }> {
  const { data, error } = await createServiceRoleClient()
    .from("turniq_shadow_decisions" as never)
    .select("id" as never)
    .eq("salon_id" as never, salonId)
    .eq("observation_fingerprint" as never, observationFingerprint)
    .maybeSingle();
  const row = data as unknown as { id?: unknown } | null;
  if (error || !row || typeof row.id !== "string") {
    throw new Error("turniq_shadow_decision_reconcile_failed");
  }
  return { id: row.id, inserted: false };
}

export const turnIqShadowTruthRepository: TurnIqShadowTruthRepository = {
  async insertOrGetDecision(row: TurnIqShadowDecisionRow) {
    const client = createServiceRoleClient();
    const { data, error } = await client
      .from("turniq_shadow_decisions" as never)
      .insert({
        salon_id: row.salonId,
        policy_version_id: row.policyVersionId,
        engine_decision_id: row.engineDecisionId,
        request_id: row.requestId,
        booking_id: row.bookingId,
        source: "receptionist_center",
        business_date: row.businessDate,
        observed_at: row.observedAt,
        snapshot_fingerprint: row.snapshotFingerprint,
        decision_fingerprint: row.decisionFingerprint,
        observation_fingerprint: row.observationFingerprint,
        recommended_staff_id: row.recommendedStaffId,
        privacy_safe_explanation: row.privacySafeExplanation,
        decision_reason_codes: row.decisionReasonCodes,
        eligible_candidate_count: row.eligibleCandidateCount,
        skipped_candidate_count: row.skippedCandidateCount,
        decision_input: row.decisionInput,
        decision_output: row.decisionOutput,
      } as never)
      .select("id" as never)
      .single();
    if (isUniqueViolation(error)) {
      return existingDecision(row.salonId, row.observationFingerprint);
    }
    const stored = data as unknown as { id?: unknown } | null;
    if (error || !stored || typeof stored.id !== "string") {
      throw new Error("turniq_shadow_decision_insert_failed");
    }
    return { id: stored.id, inserted: true };
  },

  async insertOrGetComparison(row: TurnIqShadowComparisonRow) {
    const client = createServiceRoleClient();
    const { error } = await client
      .from("turniq_shadow_comparisons" as never)
      .insert({
        salon_id: row.salonId,
        shadow_decision_id: row.shadowDecisionId,
        actual_assigned_staff_id: row.actualAssignedStaffId,
        actual_assigned_at: row.actualAssignedAt,
        customer_added_at: row.customerAddedAt,
        comparison_outcome: row.comparisonOutcome,
        divergence_reason: row.divergenceReason,
        owner_intervened: row.ownerIntervened,
        assignment_latency_seconds: row.assignmentLatencySeconds,
        privacy_safe_summary: row.privacySafeSummary,
        comparison_fingerprint: row.comparisonFingerprint,
      } as never);
    if (isUniqueViolation(error)) return { inserted: false };
    if (error) throw new Error("turniq_shadow_comparison_insert_failed");
    return { inserted: true };
  },
};
