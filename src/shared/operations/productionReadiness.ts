import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const PROBE_JOB_ID = "00000000-0000-0000-0000-000000000001";
const PROBE_SALON_ID = "00000000-0000-0000-0000-000000000002";
const EXPECTED_RESULT = "job_not_preparable";

export const REQUIRED_SCHEMA_CAPABILITY =
  "record_ai_campaign_manifest_v1";

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
 * lookup and return `job_not_preparable`; it cannot update a job or add audit
 * data. No request input reaches the service-role client.
 */
export async function probeProductionReadiness(
  timeoutMs = 3_000,
): Promise<ProductionReadiness> {
  try {
    const db = createServiceRoleClient();
    const query = db
      .rpc(
        "record_ai_campaign_manifest" as never,
        {
          p_job_id: PROBE_JOB_ID,
          p_salon_id: PROBE_SALON_ID,
          p_summary: {
            segment: "lapsed_regulars_45_365_days",
            no_messages_sent: true,
            audience_fingerprint: "e3b0c44298fc1c149afbf4c8",
            candidate_count: 0,
            eligible_count: 0,
            sms_recipient_count: 0,
            email_recipient_count: 0,
            dual_channel_count: 0,
          },
          p_recipients: [],
          p_now: new Date().toISOString(),
        } as never,
      )
      .abortSignal(AbortSignal.timeout(timeoutMs));
    const { data, error } = await query;

    if (error) {
      return {
        ready: false,
        reason:
          error.code === "PGRST202" || error.code === "42883"
            ? "schema_capability_missing"
            : "database_unavailable",
      };
    }
    if (data !== EXPECTED_RESULT) {
      return { ready: false, reason: "schema_probe_unexpected" };
    }
    return { ready: true };
  } catch {
    return { ready: false, reason: "database_unavailable" };
  }
}
