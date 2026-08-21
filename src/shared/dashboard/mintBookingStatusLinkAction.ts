"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isFrontDeskRole } from "@/shared/lib/salonMemberRole";
import { generateReminderToken } from "@/shared/noshow/generateReminderToken";

export type MintBookingStatusLinkResult =
  | { ok: true; statusCapabilityPath: string }
  | { ok: false; error: "unauthorized" | "forbidden" | "invalid_booking" | "server_error" };

/** Mint a short-lived, status-only customer link for an authorized salon desk. */
export async function mintBookingStatusLink(
  slug: string,
  bookingIdInput: string,
): Promise<MintBookingStatusLinkResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isFrontDeskRole(ctx.role)) return { ok: false, error: "forbidden" };

  const bookingId = String(bookingIdInput ?? "").trim();
  if (!bookingId) return { ok: false, error: "invalid_booking" };

  const { data: booking } = await ctx.supabase
    .from("bookings")
    .select("id, start_time_utc")
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!booking?.id) return { ok: false, error: "invalid_booking" };

  const now = Date.now();
  const appointmentGrace = Date.parse(String(booking.start_time_utc ?? "")) + 2 * 60 * 60 * 1000;
  const requestedExpiry = Number.isFinite(appointmentGrace) && appointmentGrace > now + 5 * 60 * 1000
    ? Math.min(now + 24 * 60 * 60 * 1000, appointmentGrace)
    : now + 4 * 60 * 1000;

  const capability = await generateReminderToken(bookingId, ctx.salon.id, {
    action: "status",
    expiresAt: new Date(requestedExpiry).toISOString(),
  });
  if (!capability) return { ok: false, error: "server_error" };

  return {
    ok: true,
    statusCapabilityPath: `/booking/status?token=${encodeURIComponent(capability.id)}`,
  };
}
