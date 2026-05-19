import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/** TTL: 48 hours so the token covers both 24 h and 3 h reminders. */
const TOKEN_TTL_MS = 48 * 60 * 60 * 1000;

export type ReminderToken = {
  id: string;
  expiresAt: string;
};

/**
 * Creates (or reuses the unexpired) reminder token for a booking.
 * Returns null if the booking isn't found or DB write fails.
 */
export async function generateReminderToken(
  bookingId: string,
  salonId: string,
): Promise<ReminderToken | null> {
  const supabase = createServiceRoleClient();

  // Reuse unexpired token if one already exists for this booking
  const { data: existing } = await supabase
    .from("booking_reminder_tokens" as never)
    .select("id, expires_at")
    .eq("booking_id", bookingId)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    const row = existing as { id: string; expires_at: string };
    return { id: row.id, expiresAt: row.expires_at };
  }

  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  const { data, error } = await supabase
    .from("booking_reminder_tokens" as never)
    .insert({ booking_id: bookingId, salon_id: salonId, expires_at: expiresAt })
    .select("id, expires_at")
    .single();

  if (error || !data) return null;
  const row = data as { id: string; expires_at: string };
  return { id: row.id, expiresAt: row.expires_at };
}
