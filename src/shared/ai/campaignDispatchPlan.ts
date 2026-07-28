import "server-only";

import type { ExecutionJobRow } from "@/shared/ai/executionQueue";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type CampaignDispatchPlanResult =
  | {
      ok: true;
      outcome: "created" | "unchanged";
      planId: string;
      status: "sealed";
      fingerprint: string;
      expiresAt: string;
    }
  | { ok: false; error: string };

/**
 * Seals the exact PII-free decisions from a fresh ready preflight into an
 * immutable plan. This has no outbound-provider dependency and cannot change
 * the job's dispatch_enabled=false lock.
 */
export async function sealCampaignDispatchPlan(input: {
  salonId: string;
  jobId: string;
}): Promise<CampaignDispatchPlanResult> {
  const db = createServiceRoleClient();
  const { data: rawJob, error: jobError } = await db
    .from("ai_execution_jobs" as never)
    .select("*")
    .eq("id" as never, input.jobId)
    .eq("salon_id" as never, input.salonId)
    .maybeSingle();
  const job = rawJob as ExecutionJobRow | null;
  if (jobError || !job) return { ok: false, error: "job_not_found" };
  if (
    job.action_type !== "bulk_message" ||
    job.status !== "waiting_input" ||
    job.result?.blocker !== "dispatch_not_enabled" ||
    job.payload?.dispatch_enabled !== false
  ) {
    return { ok: false, error: "job_not_plannable" };
  }

  const { data, error } = await db.rpc(
    "seal_ai_campaign_dispatch_plan" as never,
    {
      p_job_id: input.jobId,
      p_salon_id: input.salonId,
    } as never,
  );
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        outcome?: string;
        plan_id?: string;
        plan_status?: string;
        plan_fingerprint?: string;
        expires_at?: string;
      }
    | null;

  if (
    error ||
    !row?.plan_id ||
    (row.outcome !== "created" && row.outcome !== "unchanged") ||
    row.plan_status !== "sealed" ||
    !row.plan_fingerprint?.match(/^[0-9a-f]{64}$/) ||
    !row.expires_at
  ) {
    return {
      ok: false,
      error:
        typeof row?.outcome === "string"
          ? row.outcome
          : "dispatch_plan_failed",
    };
  }

  return {
    ok: true,
    outcome: row.outcome,
    planId: row.plan_id,
    status: "sealed",
    fingerprint: row.plan_fingerprint,
    expiresAt: row.expires_at,
  };
}
