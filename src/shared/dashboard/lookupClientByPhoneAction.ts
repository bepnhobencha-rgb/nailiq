"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";

/**
 * Phone-based client lookup for the receptionist walk-in form.
 *
 * Returns the GLOBAL `client_profiles` row for this phone (the table
 * is intentionally not salon-scoped per the
 * `20260509210000_client_profiles_extend.sql` doc) PLUS per-salon
 * aggregates derived from this salon's bookings only:
 *
 *   - visit_count: non-cancelled bookings for this phone in this salon
 *   - total_spent_cents: sum of price_cents on completed bookings
 *   - last_visit_at: most recent start_time_utc in this salon
 *   - top_service / top_staff: most-frequent ids (mode) in this salon
 *
 * Privacy: salon membership is verified via `getDashboardWriteClient`
 * before any read. The aggregate is scoped strictly to the caller's
 * salon — staff at salon A never see salon B's history of the same
 * phone, even though the underlying profile row is global.
 */

export type ClientLookupResult =
  | { ok: false; error: "unauthorized" | "invalid_phone" | "server_error" }
  | { ok: true; found: false; phone: string }
  | { ok: true; found: true; phone: string; profile: ClientLookupProfile };

export type ClientLookupProfile = {
  /** Display name from client_profiles (global). */
  name: string | null;
  /** Email from client_profiles (global). */
  email: string | null;
  /** Salon-agnostic VIP flag from client_profiles. */
  is_vip: boolean;
  /** Free-text notes from client_profiles (global, not salon-scoped). */
  notes: string | null;
  /** Per-salon: count of non-cancelled bookings ever. */
  visit_count: number;
  /** Per-salon: sum of price_cents on completed bookings. */
  total_spent_cents: number;
  /** Per-salon: most recent start_time_utc, or null when no past visit. */
  last_visit_at: string | null;
  /** Per-salon: most-frequent service id + name. */
  top_service: { id: string; name: string } | null;
  /** Per-salon: most-frequent staff id + name. */
  top_staff: { id: string; name: string } | null;
};

const MIN_DIGITS_FOR_LOOKUP = 8;

export async function lookupClientByPhone(
  slug: string,
  phoneRaw: string,
): Promise<ClientLookupResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  const phoneCheck = validateGuestPhone(phoneRaw);
  if (!phoneCheck.ok || phoneCheck.digits.length < MIN_DIGITS_FOR_LOOKUP) {
    return { ok: false, error: "invalid_phone" };
  }
  const phone = phoneCheck.digits;

  // Service-role client for the cross-tenant client_profiles read +
  // the per-salon bookings aggregate. Membership was already
  // confirmed above; we restrict the bookings query to ctx.salon.id
  // so this never leaks another salon's history.
  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[lookupClientByPhone] service role", e);
    return { ok: false, error: "server_error" };
  }

  type ProfileRow = {
    name?: string | null;
    email?: string | null;
    is_vip?: boolean | null;
    notes?: string | null;
  };
  const profileRes = (await admin
    .from("client_profiles")
    .select("name, email, is_vip, notes" as never)
    .eq("phone", phone)
    .is("deleted_at" as never, null)
    .maybeSingle()) as {
    data: ProfileRow | null;
    error: unknown;
  };

  // Per-salon aggregate. All bookings for this phone in this salon
  // (any status — we'll bucket in JS so we get visit + spend in one
  // round-trip).
  type BookingRow = {
    status?: string | null;
    price_cents?: number | null;
    start_time_utc?: string | null;
    service_id?: string | null;
    staff_id?: string | null;
  };
  const bookingsRes = (await admin
    .from("bookings")
    .select(
      "status, price_cents, start_time_utc, service_id, staff_id",
    )
    .eq("salon_id", ctx.salon.id)
    .eq("client_phone", phone)) as {
    data: BookingRow[] | null;
    error: unknown;
  };

  if (bookingsRes.error) {
    console.error(
      "[lookupClientByPhone] bookings",
      bookingsRes.error,
    );
    // Profile-only fallback rather than failing the lookup outright.
  }

  const bookings = bookingsRes.data ?? [];
  let visitCount = 0;
  let totalSpentCents = 0;
  let lastVisitAt: string | null = null;
  const serviceCounts = new Map<string, number>();
  const staffCounts = new Map<string, number>();

  for (const b of bookings) {
    const status = String(b.status ?? "");
    if (status === "cancelled") continue;
    visitCount += 1;
    if (status === "completed" && typeof b.price_cents === "number") {
      totalSpentCents += b.price_cents;
    }
    const ts = b.start_time_utc?.trim() ? b.start_time_utc : null;
    if (ts && (lastVisitAt == null || ts > lastVisitAt)) {
      lastVisitAt = ts;
    }
    const sid = b.service_id?.trim();
    if (sid) serviceCounts.set(sid, (serviceCounts.get(sid) ?? 0) + 1);
    const stf = b.staff_id?.trim();
    if (stf) staffCounts.set(stf, (staffCounts.get(stf) ?? 0) + 1);
  }

  function topId(map: Map<string, number>): string | null {
    let bestId: string | null = null;
    let bestCount = 0;
    for (const [id, count] of map) {
      if (count > bestCount) {
        bestId = id;
        bestCount = count;
      }
    }
    return bestId;
  }
  const topServiceId = topId(serviceCounts);
  const topStaffId = topId(staffCounts);

  // Resolve names for the top ids in this salon. Filter live rows
  // (deleted_at IS NULL) so the card doesn't show a soft-deleted
  // service/staff as a recommendation.
  let topService: ClientLookupProfile["top_service"] = null;
  let topStaff: ClientLookupProfile["top_staff"] = null;

  if (topServiceId) {
    const { data: row } = (await admin
      .from("services")
      .select("id, name")
      .eq("id", topServiceId)
      .eq("salon_id", ctx.salon.id)
      .is("deleted_at" as never, null)
      .maybeSingle()) as {
      data: { id: string; name: string | null } | null;
    };
    if (row?.id) {
      topService = { id: String(row.id), name: String(row.name ?? "").trim() };
    }
  }
  if (topStaffId) {
    const { data: row } = (await admin
      .from("staff")
      .select("id, name")
      .eq("id", topStaffId)
      .eq("salon_id", ctx.salon.id)
      .is("deleted_at" as never, null)
      .maybeSingle()) as {
      data: { id: string; name: string | null } | null;
    };
    if (row?.id) {
      topStaff = { id: String(row.id), name: String(row.name ?? "").trim() };
    }
  }

  // No profile row AND no REAL visit in this salon → genuinely new
  // customer. Return found=false so the form shows "Khách mới".
  //
  // `visitCount` already excludes cancelled bookings (see loop above), so a
  // phone whose only history is a cancelled/abandoned booking — and which has
  // no profile row — is correctly treated as new. Previously this used the raw
  // `bookings.length`, so a single leftover cancelled row made the desk forms
  // claim "✨ Khách quen — đã điền sẵn" while filling nothing (no profile name).
  const profile = profileRes.data;
  const hasProfile = !!profile;
  const hasHistory = visitCount > 0;
  if (!hasProfile && !hasHistory) {
    return { ok: true, found: false, phone };
  }

  return {
    ok: true,
    found: true,
    phone,
    profile: {
      name: profile?.name?.trim() || null,
      email: profile?.email?.trim() || null,
      is_vip: profile?.is_vip === true,
      notes: profile?.notes?.trim() || null,
      visit_count: visitCount,
      total_spent_cents: totalSpentCents,
      last_visit_at: lastVisitAt,
      top_service: topService,
      top_staff: topStaff,
    },
  };
}
