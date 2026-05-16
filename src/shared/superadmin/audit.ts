import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Shared audit-log writer for SuperAdmin server actions.
 *
 * PERMISSION_MATRIX.md §8.5 requires every mutating SuperAdmin server
 * action to write a row to `public.superadmin_audit_logs` BEFORE
 * returning. Callers should invoke this helper *before* applying the
 * underlying mutation so a half-applied state can't drift from the
 * trail — matches the impersonation pattern in `impersonationActions.ts`.
 *
 * `target_id` is a uuid column. Pass a UUID for salon/staff/service
 * targets; pass `null` for targets that aren't UUIDs (platform flag
 * keys, category slugs) and put the natural identifier in the jsonb
 * blobs instead so the viewer can still surface it.
 */
export type AuditLogInput = {
  actorUserId: string;
  actorRole: string;
  action: string;
  targetKind: string;
  targetId: string | null;
  beforeJsonb?: Record<string, unknown> | null;
  afterJsonb?: Record<string, unknown> | null;
  reason?: string | null;
};

export async function writeAuditLog(input: AuditLogInput): Promise<boolean> {
  try {
    const admin = createServiceRoleClient();
    const { error } = await admin.from("superadmin_audit_logs").insert(
      {
        actor_user_id: input.actorUserId,
        actor_role: input.actorRole,
        action: input.action,
        target_kind: input.targetKind,
        target_id: input.targetId,
        before_jsonb: input.beforeJsonb ?? null,
        after_jsonb: input.afterJsonb ?? null,
        reason: input.reason ?? null,
      } as never,
    );
    if (error) {
      console.error("[audit] insert", input.action, error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[audit] unexpected", input.action, e);
    return false;
  }
}
