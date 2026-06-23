"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

export type GroupBookingSettings = {
  declineCutoffHours: number;
};

export async function loadGroupBookingSettings(
  slug: string,
): Promise<{ ok: boolean; settings?: GroupBookingSettings }> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { ok: false };

  const db = createServiceRoleClient();
  const { data } = await db
    .from("salons" as never)
    .select("group_decline_cutoff_hours")
    .eq("id", String(resolved.salon.id))
    .single();

  if (!data) return { ok: false };
  const row = data as { group_decline_cutoff_hours?: number | null };
  return {
    ok: true,
    settings: {
      declineCutoffHours: row.group_decline_cutoff_hours ?? 2,
    },
  };
}

export async function saveGroupBookingSettings(
  slug: string,
  settings: GroupBookingSettings,
): Promise<{ ok: boolean; error?: string }> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(resolved.role)) return { ok: false, error: "unauthorized" };

  const hours = Math.round(settings.declineCutoffHours);
  if (hours < 0 || hours > 72) return { ok: false, error: "invalid_value" };

  const db = createServiceRoleClient();
  const { error } = await db
    .from("salons" as never)
    .update({ group_decline_cutoff_hours: hours } as never)
    .eq("id", String(resolved.salon.id));

  if (error) return { ok: false, error: "server_error" };
  return { ok: true };
}
