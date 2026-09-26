import "server-only";

import type { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type GroupRosterBooking = {
  id: string;
  salon_id: string;
  group_id: string | null;
  client_name: string | null;
  status: string | null;
  attendance_status: string | null;
  start_time_utc: string | null;
  end_time_utc: string | null;
  price_cents: number | null;
  wave_number: number | null;
  services: { name: string } | null;
  staff: { name: string } | null;
};

export type GroupRosterRecovery = { status: "pending" | "accepted"; booking?: GroupRosterBooking };

/** Read-only, server-only projection; never return ledger IDs or bearer material. */
export async function loadGroupRosterRecovery(
  db: ReturnType<typeof createServiceRoleClient>,
  salonId: string,
  groups: ReadonlyMap<string, string>,
  now = new Date(),
): Promise<Map<string, GroupRosterRecovery>> {
  const result = new Map<string, GroupRosterRecovery>();
  if (process.env.NAILIQ_GROUP_SLOT_RECOVERY !== "true" || groups.size === 0) return result;
  const { data, error } = await db.from("group_slot_replacements" as never)
    .select("original_booking_id,replacement_booking_id,group_id,status,expires_at")
    .eq("salon_id", salonId).in("group_id", [...new Set(groups.values())])
    .in("original_booking_id", [...groups.keys()]).in("status", ["pending", "accepted"]);
  if (error) throw new Error("group_roster_recovery_unavailable");
  const rows = (data ?? []) as unknown as Array<{ original_booking_id: string; replacement_booking_id: string | null; group_id: string; status: "pending" | "accepted"; expires_at: string }>;
  const accepted = rows.filter(row => row.status === "accepted");
  const ids = accepted.map(row => row.replacement_booking_id).filter((id): id is string => !!id);
  const byId = new Map<string, GroupRosterBooking>();
  if (ids.length) {
    const bookings = await db.from("bookings").select("id,salon_id,group_id,client_name,status,attendance_status,start_time_utc,end_time_utc,price_cents,wave_number,services!bookings_service_id_fkey(name),staff!bookings_staff_id_fkey(name)")
      .eq("salon_id", salonId).in("group_id", [...new Set(groups.values())]).in("id", ids).is("deleted_at", null);
    if (bookings.error) throw new Error("group_roster_recovery_unavailable");
    for (const booking of (bookings.data ?? []) as unknown as GroupRosterBooking[]) byId.set(booking.id, booking);
  }
  for (const row of rows) {
    if (groups.get(row.original_booking_id) !== row.group_id) throw new Error("group_roster_recovery_unavailable");
    if (row.status === "pending") {
      const expiry = Date.parse(row.expires_at);
      if (!Number.isFinite(expiry)) throw new Error("group_roster_recovery_unavailable");
      if (expiry <= now.getTime()) continue;
    }
    if (result.has(row.original_booking_id)) throw new Error("group_roster_recovery_unavailable");
    const booking = row.replacement_booking_id ? byId.get(row.replacement_booking_id) : undefined;
    if (row.status === "accepted" && (!booking || booking.group_id !== row.group_id || booking.salon_id !== salonId)) {
      throw new Error("group_roster_recovery_unavailable");
    }
    result.set(row.original_booking_id, { status: row.status, booking });
  }
  return result;
}
