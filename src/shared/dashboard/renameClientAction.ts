"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { canEditBooking } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { isValidCustomerName } from "@/shared/lib/nameFormat";

/**
 * Fix a customer's name from the booking drawer (the fastest path for a busy
 * receptionist — no navigating to a separate page).
 *
 * STRICTLY SALON-SCOPED (tenant isolation). `client_profiles` is shared by phone
 * ACROSS salons, so we deliberately do NOT touch the canonical profile name — a
 * receptionist at one salon must never change another salon's view of a
 * customer. We only rewrite the denormalized `client_name` on THIS salon's own
 * booking rows for that customer (matched by client_profile_id within the
 * salon). A guest booking with no profile updates just that one booking.
 *
 * Tradeoff: because the shared profile is untouched, this salon's profile-360 /
 * typeahead / next-booking autofill (which read the shared profile name) still
 * show the old name. Making those salon-specific without cross-tenant writes
 * needs a per-salon display-name override (separate, larger change).
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

  // Salon-scoped write only. NEVER the shared client_profiles row.
  if (profileId) {
    // All of THIS salon's bookings for that customer (past + future).
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
