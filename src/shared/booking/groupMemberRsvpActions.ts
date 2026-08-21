"use server";

import { inspectBookingManagementCapability } from "@/shared/booking/bookingManagementCapabilities";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type RsvpPageData =
  | {
      ok: true;
      bookingId: string;
      salonName: string;
      salonSlug: string;
      timezone: string;
      serviceName: string;
      staffName: string;
      startAt: string;
      memberName: string;
      organizerName: string;
      groupSize: number;
      scopeKind: "member_own" | "organizer_own";
      currentStatus: "pending" | "confirmed" | "declined" | null;
    }
  | { ok: false; code: string };

/** Load member-own RSVP display material only after both independent actions agree. */
export async function loadRsvpPageData(
  confirmToken: string,
  cancelToken: string,
): Promise<RsvpPageData> {
  if (!confirmToken || !cancelToken) return { ok: false, code: "missing_token" };
  const [confirm, cancel] = await Promise.all([
    inspectBookingManagementCapability({ tokenId: confirmToken, expectedAction: "confirm" }),
    inspectBookingManagementCapability({ tokenId: cancelToken, expectedAction: "cancel" }),
  ]);
  if (!confirm.ok) return { ok: false, code: confirm.code };
  if (!cancel.ok) return { ok: false, code: cancel.code };
  const confirmContext = confirm.inspection.context;
  const cancelContext = cancel.inspection.context;
  const memberScope = confirm.inspection.scopeKind === "member_own" || confirm.inspection.scopeKind === "organizer_own";
  if (!memberScope || confirm.inspection.scopeKind !== cancel.inspection.scopeKind ||
      confirmContext.bookingId !== cancelContext.bookingId || confirmContext.salonId !== cancelContext.salonId) {
    return { ok: false, code: "member_scope_mismatch" };
  }

  const db = createServiceRoleClient();
  const { data: booking, error: bookingError } = await db
    .from("bookings" as never)
    .select("id,client_name,group_id,status,attendance_status")
    .eq("id", confirmContext.bookingId)
    .eq("salon_id", confirmContext.salonId)
    .maybeSingle();
  if (bookingError || !booking) return { ok: false, code: "management_unavailable" };
  const row = booking as {
    id: string; client_name: string | null; group_id: string | null;
    status: string; attendance_status: string | null;
  };

  let organizerName = "";
  let groupSize = 1;
  if (row.group_id) {
    const [partyResult, countResult] = await Promise.all([
      db.from("party_links" as never).select("organizer_name").eq("group_id", row.group_id).eq("salon_id", confirmContext.salonId).maybeSingle(),
      db.from("bookings" as never).select("id", { count: "exact", head: true }).eq("group_id", row.group_id).eq("salon_id", confirmContext.salonId).is("deleted_at", null),
    ]);
    if (partyResult.error || countResult.error) return { ok: false, code: "management_unavailable" };
    organizerName = String((partyResult.data as { organizer_name?: unknown } | null)?.organizer_name ?? "");
    groupSize = countResult.count ?? 1;
  }

  return {
    ok: true,
    bookingId: row.id,
    salonName: confirm.inspection.booking.salonName,
    salonSlug: confirm.inspection.booking.salonSlug,
    timezone: confirm.inspection.booking.salonTimezone,
    serviceName: confirm.inspection.booking.serviceName ?? "",
    staffName: confirm.inspection.booking.staffName ?? "",
    startAt: confirm.inspection.booking.startTimeUtc,
    memberName: row.client_name ?? "",
    organizerName,
    groupSize,
    scopeKind: confirm.inspection.scopeKind as "member_own" | "organizer_own",
    currentStatus: row.attendance_status === "declined"
      ? "declined"
      : row.attendance_status === "confirmed"
        ? "confirmed"
        : "pending",
  };
}
