"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";

/**
 * "Người dẫn nhóm" stats for one customer (by phone) in the caller's salon:
 * how many group bookings they organized + how many guests they brought.
 * Read-only, salon-membership gated (same guard as lookupClientByPhone).
 */

export type HostStats = { groupsOrganized: number; guestsBrought: number };

export type HostStatsResult =
  | { ok: false; error: "unauthorized" | "server_error" }
  | { ok: true; stats: HostStats };

export async function getHostStats(
  slug: string,
  phone: string,
): Promise<HostStatsResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < 7) return { ok: true, stats: { groupsOrganized: 0, guestsBrought: 0 } };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[getHostStats] service role", e);
    return { ok: false, error: "server_error" };
  }

  type Row = { groups_organized?: number | null; guests_brought?: number | null };
  const { data, error } = (await admin.rpc("get_host_stats" as never, {
    p_salon_id: ctx.salon.id,
    p_phone: phone,
  } as never)) as { data: Row[] | null; error: unknown };

  if (error) {
    console.error("[getHostStats] rpc", error);
    return { ok: false, error: "server_error" };
  }

  const row = Array.isArray(data) ? data[0] : null;
  return {
    ok: true,
    stats: {
      groupsOrganized: Number(row?.groups_organized ?? 0),
      guestsBrought: Number(row?.guests_brought ?? 0),
    },
  };
}
