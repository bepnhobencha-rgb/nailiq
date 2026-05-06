import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/nextjs";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import { formatGuestPriceUsd } from "@/shared/booking/formatBookingPrice";
import { getSalonBySlug } from "@/shared/booking/getSalonBySlug";
import { createClient } from "@/shared/lib/supabase/server";

export type BookingStaffItem = {
  id: string;
  name: string;
  job_role: string;
};

export type BookingSalonMeta = {
  id: string;
  name: string;
  opening_hours: unknown | null;
  /** JSONB array of YYYY-MM-DD (holidays / exceptions). */
  booking_closed_dates: unknown | null;
  /** Flowchart: salon must be “live” (Phase 2 checklist complete). */
  acceptingBookings: boolean;
  /** Public contact for “manage booking” (call to reschedule). DB: `salons.salon_phone` only — never `salons.phone` (owner). */
  salonPhone: string | null;
};

export type BookingLoadData = {
  /** Exact `salons.slug` from DB — pass to BookingFlow/submit lookups. */
  canonicalSlug: string;
  services: BookingServiceItem[];
  staff: BookingStaffItem[];
  /** Per-staff service whitelist. `null` = salon has no rows → all-capable fallback. */
  capabilityRows: { staff_id: string; service_id: string }[] | null;
  salon: BookingSalonMeta;
};

/**
 * Booking flowchart step 4 — load booking data for the salon.
 * Caller must pass a slug already normalized + validated (`resolvePublicBookingPage`).
 *
 * When `supabase` is omitted, uses `createClient()` from `@/shared/lib/supabase/server` (cookies).
 * Pass a `@supabase/supabase-js` client for scripts outside the Next.js request scope.
 * Public catalog reads rely on RLS policies for anonymous access.
 */
export async function loadBookingServicesForSalonSlug(
  normalizedSlug: string,
  supabase?: SupabaseClient,
): Promise<BookingLoadData | null> {
  const client = supabase ?? (await createClient());

  const { salon, error: salonErr } = await getSalonBySlug(
    client,
    normalizedSlug,
  );

  if (salonErr) {
    console.error("[PUBLIC_BOOKING] loadBookingServices salon error:", salonErr);
    Sentry.captureException(salonErr, {
      tags: {
        "salon.slug": normalizedSlug,
        surface: "public_booking_load",
      },
      extra: {
        code: salonErr.code,
        hint: salonErr.message,
      },
    });
    return null;
  }
  if (!salon) {
    return null;
  }

  const canonicalSlug = String((salon as { slug?: string }).slug ?? "").trim();
  if (!canonicalSlug) {
    return null;
  }

  const salonId = String(salon.id ?? "");
  if (!salonId) return null;

  const { data: rows, error: servicesErr } = await client
    .from("services")
    .select("id, name, duration_minutes, buffer_minutes, price_cents")
    .eq("salon_id", salonId)
    .order("name", { ascending: true });

  if (servicesErr) {
    console.error("loadBookingServices error:", servicesErr);
  }

  // Public booking only sees `active` staff. `pending` and `inactive` rows
  // remain in the dashboard for the owner but never surface to customers.
  const { data: staffList, error: staffErr } = await client
    .from("staff")
    .select("id, name, job_role")
    .eq("salon_id", salonId)
    .eq("status", "active")
    .order("name", { ascending: true });

  if (staffErr) {
    console.error("loadBookingServices staff error:", staffErr);
  }

  const services: BookingServiceItem[] = (rows ?? []).map((r) => {
    const duration = Number(r.duration_minutes) || 0;
    const buffer = Number(r.buffer_minutes) || 0;
    const totalMinutes = duration + buffer;
    const priceCentsRaw = r.price_cents;
    const priceCents =
      priceCentsRaw != null && Number.isFinite(Number(priceCentsRaw))
        ? Math.round(Number(priceCentsRaw))
        : null;

    return {
      id: r.id as string,
      name: r.name as string,
      durationMinutes: duration,
      bufferMinutes: buffer,
      totalMinutes,
      priceCents,
      priceDisplay: formatGuestPriceUsd(priceCents),
    };
  });

  const staff: BookingStaffItem[] = (staffList ?? []).map((s) => ({
    id: String(s.id),
    name: String(s.name ?? ""),
    job_role: String(s.job_role ?? ""),
  }));

  let capabilityRows: { staff_id: string; service_id: string }[] | null = null;
  if (staff.length > 0) {
    const { data: capRows, error: capErr } = await client
      .from("staff_services")
      .select("staff_id, service_id")
      .in("staff_id", staff.map((s) => s.id));

    if (capErr) {
      console.error("loadBookingServices staff_services error:", capErr);
    } else if ((capRows?.length ?? 0) > 0) {
      capabilityRows = (capRows ?? []).map((r) => ({
        staff_id: String(r.staff_id),
        service_id: String(r.service_id),
      }));
    }
  }

  return {
    canonicalSlug,
    services,
    staff,
    capabilityRows,
    salon: {
      id: salonId,
      name: String((salon as { name?: string }).name ?? ""),
      opening_hours: (salon as { opening_hours?: unknown }).opening_hours ?? null,
      booking_closed_dates:
        (salon as { booking_closed_dates?: unknown }).booking_closed_dates ??
        null,
      acceptingBookings: !!(salon as { profile_complete?: unknown })
        .profile_complete,
      /** Only `salon_phone`; do not fall back to `phone` (owner / private). */
      salonPhone: (() => {
        const p = (salon as { salon_phone?: unknown }).salon_phone;
        const s = typeof p === "string" ? p.trim() : "";
        return s.length > 0 ? s : null;
      })(),
    },
  };
}
