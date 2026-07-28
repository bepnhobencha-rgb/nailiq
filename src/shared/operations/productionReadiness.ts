import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const PROBE_JOB_ID = "00000000-0000-0000-0000-000000000001";
const PROBE_SALON_ID = "00000000-0000-0000-0000-000000000002";
const PROBE_ALERT_ID = "00000000-0000-0000-0000-000000000004";
const PROBE_ACTOR_ID = "00000000-0000-0000-0000-000000000005";

export const REQUIRED_SCHEMA_CAPABILITY =
  "ai_operational_exception_signals_v1";

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
    const exceptionQuery = db
      .rpc("control_watchdog_alert" as never, {
        p_salon_id: PROBE_SALON_ID,
        p_alert_id: PROBE_ALERT_ID,
        p_operation: "acknowledge",
        p_actor_user_id: PROBE_ACTOR_ID,
        p_resolution_note: null,
      } as never)
      .abortSignal(AbortSignal.timeout(timeoutMs));
    const signalQuery = db
      .rpc("record_ai_operational_exception_signal" as never, {
        p_salon_id: PROBE_SALON_ID,
        p_dedupe_key: "readiness:nonexistent",
        p_source_type: "readiness",
        p_source_ref: "schema_probe",
        p_kind: "readiness_probe",
        p_severity: "info",
        p_title: "Readiness schema probe",
        p_body: null,
        p_signal: "recovered",
        p_evidence: { probe: true, no_write_expected: true },
        p_now: new Date(0).toISOString(),
      } as never)
      .abortSignal(AbortSignal.timeout(timeoutMs));
    const [evidenceResult, planResult, exceptionResult, signalResult] =
      await Promise.all([
      evidenceQuery,
      planQuery,
      exceptionQuery,
       signalQuery,
      ]);

    if (
      evidenceResult.error ||
      planResult.error ||
      exceptionResult.error ||
      signalResult.error
    ) {
      const error =
        evidenceResult.error ??
        planResult.error ??
        exceptionResult.error ??
        signalResult.error;
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
    const exceptionOutcome = Array.isArray(exceptionResult.data)
      ? (exceptionResult.data[0] as { outcome?: unknown } | undefined)?.outcome
      : exceptionResult.data;
    const signalOutcome = Array.isArray(signalResult.data)
      ? (signalResult.data[0] as { outcome?: unknown } | undefined)?.outcome
      : signalResult.data;
    if (
      evidenceOutcome !== "job_not_preflightable" ||
      planOutcome !== "job_not_plannable" ||
      exceptionOutcome !== "not_found" ||
      signalOutcome !== "unchanged"
    ) {
      return { ready: false, reason: "schema_probe_unexpected" };
    }
    return { ready: true };
  } catch {
    return { ready: false, reason: "database_unavailable" };
  }
}
