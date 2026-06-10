"use server";

import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getSuperAdminRole } from "@/shared/lib/superadmin";

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
};

type LoadResult =
  | { ok: true; rows: ErrorLogRow[] }
  | { ok: false; error: string };

async function requireSuperadmin(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const role = await getSuperAdminRole(user.id);
  return role ? user.id : null;
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
      "id, level, message, surface, route, salon_id, occurrence_count, first_seen_at, last_seen_at, status, ai_summary, ai_suggested_fix",
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

export async function setErrorStatus(
  id: string,
  status: "resolved" | "ignored" | "open",
): Promise<{ ok: boolean }> {
  const uid = await requireSuperadmin();
  if (!uid) return { ok: false };
  try {
    const admin = createServiceRoleClient();
    await admin
      .from("error_logs")
      .update({
        status,
        resolved_at: status === "open" ? null : new Date().toISOString(),
        resolved_by: status === "open" ? null : uid,
      } as never)
      .eq("id", id);
    return { ok: true };
  } catch (e) {
    console.error("[errorMonitor/setStatus]", e);
    return { ok: false };
  }
}
