"use server";

import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getSuperAdminRole } from "@/shared/lib/superadmin";
import type {
  AuditLogFilters,
  AuditLogRow,
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

const PAGE_SIZE = 50;

type Cursor = { createdAt: string; id: string };

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as Cursor).createdAt === "string" &&
      typeof (parsed as Cursor).id === "string"
    ) {
      return parsed as Cursor;
    }
    return null;
  } catch {
    return null;
  }
}

type RawAuditRow = {
  id: string;
  created_at: string;
  actor_user_id: string | null;
  actor_role: string;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  reason: string | null;
  before_jsonb: Record<string, unknown> | null;
  after_jsonb: Record<string, unknown> | null;
};

/**
 * Loads a paginated slice of audit log rows.
 *
 * Pagination: keyset cursor on (created_at desc, id desc). Page size
 * fixed at 50. We fetch PAGE_SIZE+1 rows and use the extra to detect
 * whether a next page exists (no count() query needed).
 *
 * Actor enrichment: after fetching the page, collect unique
 * actor_user_ids and batch via admin.auth.admin.listUsers to attach
 * the actor's email. Same pattern as `superadminAuth.ts`.
 */
export async function loadSuperadminAuditLogs(
  filters: AuditLogFilters = {},
  cursor: string | null = null,
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

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[auditLogs/load] service role", e);
    return { ok: false, error: "server_error" };
  }

  const decoded = decodeCursor(cursor);

  type Builder = ReturnType<typeof admin.from> & {
    select: (cols: string) => Builder;
    order: (
      col: string,
      opts?: { ascending?: boolean },
    ) => Builder;
    limit: (n: number) => Builder;
    in: (col: string, values: readonly string[]) => Builder;
    eq: (col: string, value: string) => Builder;
    gte: (col: string, value: string) => Builder;
    lt: (col: string, value: string) => Builder;
    or: (clause: string) => Builder;
    then: Promise<{
      data: RawAuditRow[] | null;
      error: { message: string } | null;
    }>["then"];
  };

  let query = admin
    .from("superadmin_audit_logs")
    .select(
      "id, created_at, actor_user_id, actor_role, action, target_kind, target_id, reason, before_jsonb, after_jsonb",
    )
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(PAGE_SIZE + 1) as unknown as Builder;

  if (filters.actions && filters.actions.length > 0) {
    query = query.in("action", filters.actions);
  }
  if (filters.actorUserId) {
    query = query.eq("actor_user_id", filters.actorUserId);
  }
  if (filters.targetKinds && filters.targetKinds.length > 0) {
    query = query.in("target_kind", filters.targetKinds);
  }
  if (filters.from) {
    query = query.gte("created_at", filters.from);
  }
  if (filters.to) {
    query = query.lt("created_at", filters.to);
  }
  if (decoded) {
    // Keyset on (created_at desc, id desc):
    // `(created_at, id) < (decoded.createdAt, decoded.id)`
    query = query.or(
      `created_at.lt.${decoded.createdAt},and(created_at.eq.${decoded.createdAt},id.lt.${decoded.id})`,
    );
  }

  const queryResult = (await query) as unknown as {
    data: RawAuditRow[] | null;
    error: { message: string } | null;
  };
  if (queryResult.error) {
    console.error("[auditLogs/load] query", queryResult.error);
    return { ok: false, error: "server_error" };
  }

  const pageRaw = queryResult.data ?? [];
  const hasMore = pageRaw.length > PAGE_SIZE;
  const visible = hasMore ? pageRaw.slice(0, PAGE_SIZE) : pageRaw;

  // Enrich actor_user_id → email via listUsers. SuperAdmin operator
  // count is small (well under the 1000 perPage cap) — single batch
  // is cheaper than per-row getUserById.
  const emailByUserId = new Map<string, string | null>();
  const uniqueActorIds = new Set<string>();
  for (const row of visible) {
    if (row.actor_user_id) uniqueActorIds.add(row.actor_user_id);
  }
  if (uniqueActorIds.size > 0) {
    const { data: userList, error: listErr } =
      await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listErr) {
      console.error("[auditLogs/load] listUsers", listErr);
      // Soft-fail: rows render without actor email rather than 500.
    } else {
      for (const u of userList.users) {
        if (uniqueActorIds.has(u.id)) {
          emailByUserId.set(u.id, u.email ?? null);
        }
      }
    }
  }

  const rows: AuditLogRow[] = visible.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    actorUserId: r.actor_user_id,
    actorEmail: r.actor_user_id ? emailByUserId.get(r.actor_user_id) ?? null : null,
    actorRole: r.actor_role,
    action: r.action,
    targetKind: r.target_kind,
    targetId: r.target_id,
    reason: r.reason,
    beforeJsonb: r.before_jsonb,
    afterJsonb: r.after_jsonb,
  }));

  const nextCursor =
    hasMore && visible.length > 0
      ? encodeCursor({
          createdAt: visible[visible.length - 1].created_at,
          id: visible[visible.length - 1].id,
        })
      : null;

  // `prevCursor` is "the cursor that *got us here*". The page's
  // navigation rebuilds Previous links from the cursor history in the
  // URL (the calling page tracks it). We expose the inbound cursor so
  // the caller can decide to show a back link.
  const prevCursor = decoded ? cursor : null;

  return { ok: true, rows, nextCursor, prevCursor };
}

export type AuditActorOption = { id: string; email: string };

export type LoadAuditActorOptionsResult =
  | { ok: true; actors: AuditActorOption[] }
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" };

/**
 * Lists the superadmin operators eligible to appear in the audit-log
 * filter bar's "Actor" dropdown. Reads from `public.superadmins` so
 * only current superadmins surface (revoked rows are hidden via the
 * revoked_at filter).
 */
export async function loadAuditActorOptions(): Promise<LoadAuditActorOptionsResult> {
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

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[auditLogs/actorOptions] service role", e);
    return { ok: false, error: "server_error" };
  }

  const { data: rows, error } = (await admin
    .from("superadmins")
    .select("user_id, revoked_at" as never)) as {
    data: Array<{ user_id: string; revoked_at: string | null }> | null;
    error: unknown;
  };
  if (error) {
    console.error("[auditLogs/actorOptions] query", error);
    return { ok: false, error: "server_error" };
  }

  const activeIds = new Set<string>();
  for (const r of rows ?? []) {
    if (r.revoked_at === null) activeIds.add(r.user_id);
  }
  if (activeIds.size === 0) {
    return { ok: true, actors: [] };
  }

  const { data: userList, error: listErr } =
    await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) {
    console.error("[auditLogs/actorOptions] listUsers", listErr);
    return { ok: false, error: "server_error" };
  }

  const actors: AuditActorOption[] = [];
  for (const u of userList.users) {
    if (activeIds.has(u.id) && u.email) {
      actors.push({ id: u.id, email: u.email });
    }
  }
  actors.sort((a, b) => a.email.localeCompare(b.email));
  return { ok: true, actors };
}
