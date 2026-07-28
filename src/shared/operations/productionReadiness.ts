import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const PROBE_JOB_ID = "00000000-0000-0000-0000-000000000001";
const PROBE_SALON_ID = "00000000-0000-0000-0000-000000000002";

export const REQUIRED_SCHEMA_CAPABILITY =
  "immutable_ai_campaign_dispatch_plan_v1";

export type ProductionReadiness =
  | { ready: true }
  | {
      ready: false;
      reason:
        | "database_unavailable"
        | "schema_capability_missing"
        | "schema_probe_unexpected";
    };

/**
 * Prove that the deployed app can reach its database and that the latest
 * required schema capability is present.
 *
 * The probe supplies fixed UUIDs that cannot match a real row and a valid,
 * zero-recipient summary. The RPC must therefore stop at its tenant-scoped
 * lookup and return `job_not_preflightable`; it cannot update a job or add audit
 * data. No request input reaches the service-role client.
 */
export async function probeProductionReadiness(
  timeoutMs = 3_000,
): Promise<ProductionReadiness> {
  try {
    const db = createServiceRoleClient();
    const evidenceQuery = db
      .rpc("record_ai_campaign_preflight_evidence" as never, {
          p_job_id: PROBE_JOB_ID,
          p_salon_id: PROBE_SALON_ID,
          p_summary: {
            manifest_id: "00000000-0000-0000-0000-000000000003",
            no_messages_sent: true,
            dispatch_enabled: false,
            preflight_fingerprint:
              "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            manifest_recipient_count: 0,
            eligible_count: 0,
            sms_recipient_count: 0,
            email_recipient_count: 0,
            dual_channel_count: 0,
            excluded_recent_contact: 0,
            excluded_no_consent: 0,
            excluded_no_channel: 0,
            excluded_missing_profile: 0,
            excluded_manifest_channel_unavailable: 0,
            estimated_cost_usd_cents: 0,
            recipient_cap: 500,
            cost_cap_usd_cents: 500,
          },
          p_decisions: [],
        } as never)
      .abortSignal(AbortSignal.timeout(timeoutMs));
    const planQuery = db
      .rpc("seal_ai_campaign_dispatch_plan" as never, {
        p_job_id: PROBE_JOB_ID,
        p_salon_id: PROBE_SALON_ID,
      } as never)
      .abortSignal(AbortSignal.timeout(timeoutMs));
    const [evidenceResult, planResult] = await Promise.all([
      evidenceQuery,
      planQuery,
    ]);

    if (evidenceResult.error || planResult.error) {
      const error = evidenceResult.error ?? planResult.error;
      return {
        ready: false,
        reason:
          error?.code === "PGRST202" || error?.code === "42883"
            ? "schema_capability_missing"
            : "database_unavailable",
      };
    }
    const evidenceOutcome = Array.isArray(evidenceResult.data)
      ? (evidenceResult.data[0] as { outcome?: unknown } | undefined)?.outcome
      : evidenceResult.data;
    const planOutcome = Array.isArray(planResult.data)
      ? (planResult.data[0] as { outcome?: unknown } | undefined)?.outcome
      : planResult.data;
    if (
      evidenceOutcome !== "job_not_preflightable" ||
      planOutcome !== "job_not_plannable"
    ) {
      return { ready: false, reason: "schema_probe_unexpected" };
    }
    return { ready: true };
  } catch {
    return { ready: false, reason: "database_unavailable" };
  }
}
