import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Attribute the change(s) an owner-gated server action just made to the user who
 * made them. The DB trigger logs system_audit rows with actor_user_id = null
 * (PostgREST runs each statement in its own transaction, so SET LOCAL can't
 * carry an actor into the trigger). Right after the write, back-patch the recent
 * unattributed rows for the affected table(s) with the caller's user id, so the
 * Activity log can show "X đã đổi …" instead of an anonymous change.
 *
 * Best-effort — never throws. The 15s window + table filter keep it scoped to
 * this action's own writes.
 */
export async function attributeRecentAudit(
  salonId: string,
  tableNames: string[],
  userId: string | null,
): Promise<void> {
  if (!userId || tableNames.length === 0) return;
  try {
    const db = createServiceRoleClient();
    await db
      .from("system_audit" as never)
      .update({ actor_user_id: userId } as never)
      .eq("salon_id", salonId)
      .in("table_name", tableNames)
      .is("actor_user_id", null)
      .gt("created_at", new Date(Date.now() - 15_000).toISOString());
  } catch (e) {
    console.error("[attributeRecentAudit]", e);
  }
}
