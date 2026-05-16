"use server";

import { createClient } from "@/shared/lib/supabase/server";
import { getSuperAdminRole } from "@/shared/lib/superadmin";
import type {
  AuditLogFilters,
  LoadAuditLogsResult,
} from "@/shared/superadmin/superadminTypes";

/**
 * SuperAdmin audit-log read surface (Phase 1F).
 *
 * Read-only loader for `public.superadmin_audit_logs`. The table is
 * append-only — writers live in `audit.ts` (shared helper) and the
 * per-action writers in `superadminActions.ts` /
 * `impersonationActions.ts`.
 *
 * Role gate: per PERMISSION_MATRIX §8.2/§8.3, four of the six
 * SuperAdmin roles see the audit trail. `billing_admin` and `ai_admin`
 * are scoped outside this content and are denied here even though the
 * shell layout already gates non-superadmins out. Defense in depth.
 */

const AUDIT_LOG_VIEWER_ROLES = new Set<string>([
  "founder",
  "ops_admin",
  "support_admin",
  "readonly_analyst",
]);

/**
 * Loads a paginated slice of audit log rows.
 *
 * Step 1 skeleton: returns an empty page so callers can integrate
 * against the type signature. Step 3 wires the real Supabase query +
 * keyset cursor + actor email enrichment.
 */
export async function loadSuperadminAuditLogs(
  _filters: AuditLogFilters = {},
  _cursor: string | null = null,
): Promise<LoadAuditLogsResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };

  const role = await getSuperAdminRole(user.id);
  if (!role) return { ok: false, error: "unauthorized" };
  if (!AUDIT_LOG_VIEWER_ROLES.has(role)) {
    return { ok: false, error: "forbidden" };
  }

  // Step 1: skeleton. Real query lands in step 3.
  return { ok: true, rows: [], nextCursor: null, prevCursor: null };
}
