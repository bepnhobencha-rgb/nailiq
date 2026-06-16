"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { canEditBooking } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { isValidCustomerName } from "@/shared/lib/nameFormat";

/**
 * Fix a customer's name from the booking drawer (the fastest path for a busy
 * receptionist — no navigating to a separate page).
 *
 * Identity-layer aware: the canonical name lives on `client_profiles` (phone-
 * keyed), while each booking stores a denormalized `client_name` for display /
 * search / conflict checks. We update BOTH so the fix sticks AND shows
 * immediately:
 *  - the linked profile's `name` (so future bookings auto-fill the corrected
 *    name), and
 *  - this SALON's bookings for that profile (so the corrected name shows on every
 *    appointment the salon sees). We deliberately do NOT rewrite OTHER salons'
 *    booking rows — `client_profiles` is shared by phone across tenants, so we
 *    only touch the canonical name + the caller salon's own rows.
 *
 * A guest booking with no profile updates just that one booking's name.
 */
export async function renameBookingClient(
  slug: string,
  input: { bookingId: string; name: string },
): Promise<{ ok: boolean; name?: string; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  // Same front-desk gate as editing a booking (owner/admin/senior/receptionist).
  if (!canEditBooking(ctx.role)) return { ok: false, error: "forbidden" };

  const bookingId = String(input.bookingId ?? "").trim();
  const name = String(input.name ?? "").trim();
  if (!bookingId) return { ok: false, error: "invalid_booking" };
  if (!isValidCustomerName(name)) return { ok: false, error: "invalid_name" };

  const sb = createServiceRoleClient();

  // Booking must be in the caller's salon (tenant isolation).
  const { data: bk } = await sb
    .from("bookings")
    .select("id, client_profile_id")
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();
  if (!(bk as { id?: string } | null)?.id) return { ok: false, error: "invalid_booking" };

  const profileId = (bk as { client_profile_id?: string | null }).client_profile_id ?? null;

  if (profileId) {
    // Canonical name on the shared profile (so it sticks for future visits).
    const { error: pe } = await sb
      .from("client_profiles")
      .update({ name } as never)
      .eq("id", profileId);
    if (pe) return { ok: false, error: pe.message };
    // Backfill THIS salon's bookings for that profile (display everywhere here).
    const { error: be } = await sb
      .from("bookings")
      .update({ client_name: name } as never)
      .eq("client_profile_id", profileId)
      .eq("salon_id", ctx.salon.id);
    if (be) return { ok: false, error: be.message };
  } else {
    // Guest booking with no identity profile → just this booking.
    const { error: be } = await sb
      .from("bookings")
      .update({ client_name: name } as never)
      .eq("id", bookingId)
      .eq("salon_id", ctx.salon.id);
    if (be) return { ok: false, error: be.message };
  }

  return { ok: true, name };
}
