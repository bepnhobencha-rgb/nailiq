"use server";

import { revalidatePath } from "next/cache";

import type {
  OperationalExceptionOperation,
  OperationalExceptionStatus,
} from "@/shared/ai/operationalExceptionTypes";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type ControlOperationalExceptionResult =
  | { ok: true; status: OperationalExceptionStatus; changed: boolean }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "forbidden"
        | "not_found"
        | "invalid_state"
        | "invalid_note"
        | "server_error";
    };

export async function controlOperationalExceptionAction(input: {
  slug: string;
  alertId: string;
  operation: OperationalExceptionOperation;
  resolutionNote?: string;
}): Promise<ControlOperationalExceptionResult> {
  const ctx = await getDashboardWriteClient(input.slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const note = input.resolutionNote?.trim() || null;
  if (note && note.length > 500) return { ok: false, error: "invalid_note" };

  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(
    "control_watchdog_alert" as never,
    {
      p_salon_id: ctx.salon.id,
      p_alert_id: input.alertId,
      p_operation: input.operation,
      p_actor_user_id: ctx.userId,
      p_resolution_note: note,
    } as never,
  );
  if (error) {
    console.error("[controlOperationalExceptionAction]", error);
    return { ok: false, error: "server_error" };
  }

  const row = (Array.isArray(data) ? data[0] : data) as {
    outcome?: unknown;
    alert_status?: unknown;
  } | null;
  if (row?.outcome === "not_found") return { ok: false, error: "not_found" };
  if (row?.outcome === "invalid_state") {
    return { ok: false, error: "invalid_state" };
  }
  if (
    (row?.outcome !== "updated" && row?.outcome !== "unchanged") ||
    !["open", "acknowledged", "resolved"].includes(String(row.alert_status))
  ) {
    return { ok: false, error: "server_error" };
  }

  revalidatePath(`/dashboard/${input.slug}/ai`);
  return {
    ok: true,
    status: row.alert_status as OperationalExceptionStatus,
    changed: row.outcome === "updated",
  };
}
