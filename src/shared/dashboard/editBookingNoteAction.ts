"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { canEditBooking } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const NOTE_MAX = 2000;

/**
 * Edit a booking's note (`bookings.client_notes`) inline from the drawer — the
 * fastest path for the desk to add/fix an appointment note. Booking-scoped (no
 * identity/profile involved), front-desk roles only, any status. Empty → null.
 */
export async function updateBookingNote(
  slug: string,
  input: { bookingId: string; note: string },
): Promise<{ ok: boolean; note?: string | null; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  // Same front-desk gate as editing a booking (owner/admin/senior/receptionist).
  if (!canEditBooking(ctx.role)) return { ok: false, error: "forbidden" };

  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId) return { ok: false, error: "invalid_booking" };
  const trimmed = String(input.note ?? "").trim().slice(0, NOTE_MAX);
  const value = trimmed.length === 0 ? null : trimmed;

  const sb = createServiceRoleClient();
  // Booking must be in the caller's salon (tenant isolation).
  const { data: bk } = await sb
    .from("bookings")
    .select("id")
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();
  if (!(bk as { id?: string } | null)?.id) return { ok: false, error: "invalid_booking" };

  const { error } = await sb
    .from("bookings")
    .update({ client_notes: value } as never)
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id);
  if (error) return { ok: false, error: error.message };

  return { ok: true, note: value };
}
