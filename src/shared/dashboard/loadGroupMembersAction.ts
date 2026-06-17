"use server";

/**
 * loadGroupMembersAction — who's in a party, for the desk booking drawer.
 *
 * When a receptionist opens a booking that belongs to a group, the drawer
 * shows the whole party ("who's going with whom") instead of forcing them to
 * hunt the separate Party Card strip. Returns every non-cancelled sibling in
 * the group with name + service + staff + time, marks the organizer (the only
 * row carrying contact info) and the seat-together preference.
 *
 * Security contract:
 *   - Caller must be an authenticated salon member (getDashboardWriteClient).
 *   - Members are scoped to the caller's salon AND the requested group_id.
 *   - Member phone numbers are NEVER returned (privacy contract, like
 *     loadPartyCardsAction).
 */

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { formatInSalonTz } from "@/shared/lib/salonTime";

export type GroupMember = {
  bookingId: string;
  /** Display name (already trimmed; "Guest N" fallbacks come from the row). */
  name: string;
  serviceName: string;
  staffName: string;
  /** Salon-tz wall-clock start, e.g. "2:30 PM". */
  startDisplay: string;
  waveNumber: number | null;
  /** The organizer (member 0) is the only row with a phone/email on file. */
  isOrganizer: boolean;
};

export type LoadGroupMembersResult =
  | {
      ok: true;
      members: GroupMember[];
      organizerName: string | null;
      seatTogether: boolean;
    }
  | { ok: false; error: "unauthorized" | "server_error" };

export async function loadGroupMembersAction(
  slug: string,
  groupId: string,
): Promise<LoadGroupMembersResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  const gid = String(groupId ?? "").trim();
  if (!gid) return { ok: false, error: "server_error" };

  const tz =
    typeof ctx.salon.timezone === "string" && ctx.salon.timezone.trim()
      ? ctx.salon.timezone.trim()
      : "UTC";

  let db: ReturnType<typeof createServiceRoleClient>;
  try {
    db = createServiceRoleClient();
  } catch {
    // No service-role key → degrade gracefully (drawer just omits the section).
    return { ok: true, members: [], organizerName: null, seatTogether: false };
  }

  const { data, error } = await db
    .from("bookings")
    .select(
      `
      id,
      client_name,
      client_phone,
      client_email,
      start_time_utc,
      wave_number,
      seat_together,
      services!bookings_service_id_fkey ( name ),
      staff!bookings_staff_id_fkey ( name )
    `,
    )
    .eq("salon_id", ctx.salon.id)
    .eq("group_id", gid)
    .neq("status", "cancelled");

  if (error) {
    console.error("[loadGroupMembersAction]", error);
    return { ok: false, error: "server_error" };
  }

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    client_name: string | null;
    client_phone: string | null;
    client_email: string | null;
    start_time_utc: string | null;
    wave_number: number | null;
    seat_together: boolean | null;
    services: { name: string | null } | null;
    staff: { name: string | null } | null;
  }>;

  const members: GroupMember[] = rows
    .map((r) => ({
      bookingId: String(r.id),
      name: String(r.client_name ?? "").trim() || "Guest",
      serviceName: String(r.services?.name ?? "").trim(),
      staffName: String(r.staff?.name ?? "").trim(),
      startDisplay: r.start_time_utc
        ? formatInSalonTz(r.start_time_utc, tz, "time")
        : "",
      waveNumber: r.wave_number ?? null,
      isOrganizer: Boolean(r.client_phone || r.client_email),
    }))
    .sort((a, b) => a.startDisplay.localeCompare(b.startDisplay));

  const organizer = rows.find((r) => r.client_phone || r.client_email);
  const seatTogether = rows.some((r) => r.seat_together === true);

  return {
    ok: true,
    members,
    organizerName: organizer
      ? String(organizer.client_name ?? "").trim() || null
      : null,
    seatTogether,
  };
}
