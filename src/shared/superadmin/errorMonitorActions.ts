"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { requireActiveSuperAdminSession } from "@/shared/auth/requireActiveSuperAdminSession";
import {
  validateErrorQaEvidence,
  type ErrorRemediationState,
} from "@/shared/observability/remediationPolicy";

export type ErrorLogRow = {
  id: string;
  level: "fatal" | "error" | "warning";
  message: string;
  surface: string | null;
  route: string | null;
  salon_id: string | null;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  status: "open" | "resolved" | "ignored";
  ai_summary: string | null;
  ai_suggested_fix: string | null;
  fix_proposal: string | null;
  fix_file: string | null;
  fix_pr_url: string | null;
  remediation_state: ErrorRemediationState;
  qa_candidate_sha: string | null;
  qa_evidence: string | null;
  qa_passed_at: string | null;
  qa_passed_by: string | null;
  resolution_approved_at: string | null;
  resolution_approved_by: string | null;
  stack: string | null;
  context: Record<string, unknown> | null;
};

type LoadResult =
  { ok: true; rows: ErrorLogRow[] } | { ok: false; error: string };

async function requireSuperadmin(): Promise<string | null> {
  const access = await requireActiveSuperAdminSession();
  return access.ok ? access.user.id : null;
}

async function requireErrorQaOperator(): Promise<string | null> {
  const access = await requireActiveSuperAdminSession();
  return access.ok && (access.role === "founder" || access.role === "ops_admin")
    ? access.user.id
    : null;
}

async function requireProductOwner(): Promise<string | null> {
  const access = await requireActiveSuperAdminSession();
  return access.ok && access.role === "founder" ? access.user.id : null;
}

export async function loadErrorLogs(
  status: "open" | "resolved" | "all" = "open",
): Promise<LoadResult> {
  const uid = await requireSuperadmin();
  if (!uid) return { ok: false, error: "unauthorized" };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[errorMonitor/load] service role", e);
    return { ok: false, error: "server_error" };
  }

  let q = admin
    .from("error_logs")
    .select(
      "id, level, message, surface, route, salon_id, occurrence_count, first_seen_at, last_seen_at, status, ai_summary, ai_suggested_fix, fix_proposal, fix_file, fix_pr_url, remediation_state, qa_candidate_sha, qa_evidence, qa_passed_at, qa_passed_by, resolution_approved_at, resolution_approved_by, stack, context",
    )
    .order("last_seen_at", { ascending: false })
    .limit(200);
  if (status !== "all") q = q.eq("status", status);

  const { data, error } = await q;
  if (error) {
    console.error("[errorMonitor/load]", error);
    return { ok: false, error: "server_error" };
  }
  return { ok: true, rows: (data ?? []) as ErrorLogRow[] };
}

/** On-demand AI triage from the admin page (the cron also does this every 10m). */
export async function triageErrorNow(id: string): Promise<{ ok: boolean }> {
  const uid = await requireSuperadmin();
  if (!uid) return { ok: false };
  const { triageError } = await import("@/shared/observability/triageError");
  return triageError(id);
}

/** AI reads the offending file + drafts a fix (and a draft PR if a GitHub
 *  token is configured). Always a draft for human review. */
export async function draftFixNow(
  id: string,
): Promise<{ ok: boolean; prUrl?: string | null }> {
  const uid = await requireSuperadmin();
  if (!uid) return { ok: false };
  const { draftFix } = await import("@/shared/observability/draftFix");
  return draftFix(id);
}

export async function setErrorStatus(
  id: string,
  status: "resolved" | "ignored" | "open",
): Promise<{ ok: boolean }> {
  const uid = await requireSuperadmin();
  if (!uid) return { ok: false };
  try {
    const admin = createServiceRoleClient();
    let query = admin
      .from("error_logs")
      .update({
        status,
        resolved_at: status === "open" ? null : new Date().toISOString(),
        resolved_by: status === "open" ? null : uid,
      } as never)
      .eq("id", id);
    if (status === "resolved") {
      query = query.eq("remediation_state" as never, "approved");
    }
    const { data, error } = await query.select("id").maybeSingle();
    return { ok: !error && Boolean(data) };
  } catch (e) {
    console.error("[errorMonitor/setStatus]", e);
    return { ok: false };
  }
}

export async function recordErrorQaPass(input: {
  id: string;
  candidateSha: string;
  evidence: string;
}): Promise<{ ok: boolean; error?: string }> {
  const uid = await requireErrorQaOperator();
  if (!uid) return { ok: false, error: "unauthorized" };
  const validated = validateErrorQaEvidence(input);
  if (!validated.ok) return validated;

  try {
    const admin = createServiceRoleClient();
    const now = new Date().toISOString();
    const { data, error } = await admin
      .from("error_logs")
      .update({
        remediation_state: "qa_passed",
        qa_candidate_sha: validated.candidateSha,
        qa_evidence: validated.evidence,
        qa_passed_at: now,
        qa_passed_by: uid,
      } as never)
      .eq("id", input.id)
      .eq("status", "open")
      .in("remediation_state" as never, ["detected", "triaged", "fix_proposed"] as never)
      .select("id")
      .maybeSingle();
    return { ok: !error && Boolean(data), ...(error ? { error: "qa_gate_failed" } : {}) };
  } catch (error) {
    console.error("[errorMonitor/recordQa]", error);
    return { ok: false, error: "server_error" };
  }
}

export async function approveErrorResolution(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const uid = await requireProductOwner();
  if (!uid) return { ok: false, error: "product_owner_required" };

  try {
    const admin = createServiceRoleClient();
    const { data, error } = await admin
      .from("error_logs")
      .update({
        remediation_state: "approved",
        resolution_approved_at: new Date().toISOString(),
        resolution_approved_by: uid,
      } as never)
      .eq("id", id)
      .eq("status", "open")
      .eq("remediation_state" as never, "qa_passed")
      .select("id")
      .maybeSingle();
    return {
      ok: !error && Boolean(data),
      ...(error ? { error: "approval_gate_failed" } : {}),
    };
  } catch (error) {
    console.error("[errorMonitor/approveResolution]", error);
    return { ok: false, error: "server_error" };
  }
}
