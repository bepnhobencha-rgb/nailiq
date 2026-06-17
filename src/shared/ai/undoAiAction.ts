"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

/**
 * Undo an AI action within its undo_deadline window.
 *
 * Note: SMS/email already delivered to the customer cannot be recalled.
 * "Undo" here means: mark the action as reversed in the audit log,
 * reset the winback_suggestion to "undone" so it can be re-suggested
 * after the next 30-day window, and surface the cancellation in the feed.
 */
export async function undoAiAction(
  slug: string,
  actionId: string,
): Promise<{ ok: true } | { ok: false; error: "unauthorized" | "expired" | "already_undone" | "not_found" | "server_error" }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "unauthorized" };

  const db = createServiceRoleClient();

  const { data: action } = await db
    .from("ai_actions_log")
    .select("id, salon_id, target_id, undo_deadline, undone_at" as never)
    .eq("id", actionId)
    .maybeSingle();

  const a = action as {
    id: string;
    salon_id: string;
    target_id: string | null;
    undo_deadline: string | null;
    undone_at: string | null;
  } | null;

  if (!a) return { ok: false, error: "not_found" };
  if (a.salon_id !== ctx.salon.id) return { ok: false, error: "unauthorized" };
  if (a.undone_at) return { ok: false, error: "already_undone" };
  if (!a.undo_deadline || new Date(a.undo_deadline) < new Date()) {
    return { ok: false, error: "expired" };
  }

  const now = new Date().toISOString();

  try {
    await db
      .from("ai_actions_log")
      .update({ undone_at: now } as never)
      .eq("id", actionId);

    // Reset the linked winback suggestion so it can be re-suggested later
    if (a.target_id) {
      await db
        .from("winback_suggestions")
        .update({ status: "undone" } as never)
        .eq("id", a.target_id)
        .eq("salon_id", ctx.salon.id);
    }

    return { ok: true };
  } catch (e) {
    console.error("[undoAiAction]", e);
    return { ok: false, error: "server_error" };
  }
}
