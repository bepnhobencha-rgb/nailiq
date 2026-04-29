import type { BookingServiceItem } from "@/shared/booking/catalog";
import { formatGuestPriceUsd } from "@/shared/booking/formatBookingPrice";
import { getSalonBySlug } from "@/shared/booking/getSalonBySlug";
import { normalizePublicBookingSlug } from "@/shared/booking/normalizePublicBookingSlug";
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
  /** Public contact for “manage booking” (call to reschedule). */
  salonPhone: string | null;
};

export type BookingLoadData = {
  /** Exact `salons.slug` from DB — pass to BookingFlow/submit lookups (URLs may fuzzy-match). */
  canonicalSlug: string;
  services: BookingServiceItem[];
  staff: BookingStaffItem[];
  salon: BookingSalonMeta;
};

/**
 * Loads bookable services + staff + salon meta for a public salon URL slug.
 * Returns `null` if the salon does not exist.
 *
 * Uses `createClient()` from `@/shared/lib/supabase/server` — anon publishable key + cookies
 * (not the service role). Public catalog reads rely on RLS policies for anonymous access.
 */
export async function loadBookingServicesForSalonSlug(
  shopSlug: string,
): Promise<BookingLoadData | null> {
  const normalized = normalizePublicBookingSlug(shopSlug);
  const supabase = await createClient();

  const { salon, error: salonErr } = await getSalonBySlug(supabase, normalized);

  if (salonErr) {
    console.error("[PUBLIC_BOOKING] loadBookingServices salon error:", salonErr);
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

  const { data: rows, error: servicesErr } = await supabase
    .from("services")
    .select("id, name, duration_minutes, buffer_minutes, price_cents")
    .eq("salon_id", salonId)
    .order("name", { ascending: true });

  if (servicesErr) {
    console.error("loadBookingServices error:", servicesErr);
  }

  const { data: staffList, error: staffErr } = await supabase
    .from("staff")
    .select("id, name, job_role")
    .eq("salon_id", salonId)
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

  return {
    canonicalSlug,
    services,
    staff,
    salon: {
      id: salonId,
      name: String((salon as { name?: string }).name ?? ""),
      opening_hours: (salon as { opening_hours?: unknown }).opening_hours ?? null,
      booking_closed_dates:
        (salon as { booking_closed_dates?: unknown }).booking_closed_dates ??
        null,
      acceptingBookings: !!(salon as { profile_complete?: unknown })
        .profile_complete,
      salonPhone: (() => {
        const p = (salon as { salon_phone?: unknown }).salon_phone;
        const s = typeof p === "string" ? p.trim() : "";
        return s.length > 0 ? s : null;
      })(),
    },
  };
}
