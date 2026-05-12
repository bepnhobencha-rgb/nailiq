import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/nextjs";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import { formatBookingPrice } from "@/shared/booking/formatBookingPrice";
import { getSalonBySlug } from "@/shared/booking/getSalonBySlug";
import { parseServiceCategory } from "@/shared/booking/serviceCategory";
import { createClient } from "@/shared/lib/supabase/server";
import { normalizeBrandColor } from "@/shared/lib/brandColor";
import { parseCurrency, type Currency } from "@/shared/lib/currencyFormat";

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
  /** IANA TZ for slot-grid label and confirmation copy (B-16). DB column is NOT NULL DEFAULT 'America/Los_Angeles'; "UTC" is a paranoid fallback. */
  timezone: string;
  /** Per-salon primary color for the booking page (PR #109). Always
   * a `#RRGGBB` literal — `normalizeBrandColor` falls back to the
   * default gold when the column is missing or invalid. */
  brandColor: string;
  /** Per-salon light/dark theme for the public booking page only.
   * Defaults to `"dark"` for legacy rows and any invalid value. */
  themeMode: "dark" | "light";
  /** Salon's display currency (CAD / USD / VND). Service prices and
   *  totals on the booking page render in this currency. */
  currencyCode: Currency;
  /** Public street address (`salons.address`). Single free-form text
   * column — caller renders verbatim. `null` when the owner hasn't
   * completed the Address setup step. */
  address: string | null;
  /** P2.8 — owner-editable salon description rendered as the booking
   * page tagline. `null` falls back to the generic copy in
   * `bookingEn.salonHeroTagline`. */
  description: string | null;
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
    // `category`, `description`, `is_popular`, `is_featured` were added
    // in migrations 20260511500000 and 20260511600000; not yet in the
    // auto-generated DB types so the SELECT spread is cast.
    .select(
      "id, name, duration_minutes, buffer_minutes, price_cents, category, description, is_popular, is_featured" as never,
    )
    .eq("salon_id", salonId)
    .is("deleted_at" as never, null)
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
    .is("deleted_at" as never, null)
    .order("name", { ascending: true });

  if (staffErr) {
    console.error("loadBookingServices staff error:", staffErr);
  }

  const salonCurrency = parseCurrency(
    (salon as { currency_code?: unknown }).currency_code,
  );

  const services: BookingServiceItem[] = (rows ?? []).map((r) => {
    const row = r as unknown as {
      id: string;
      name: string;
      duration_minutes?: unknown;
      buffer_minutes?: unknown;
      price_cents?: unknown;
      category?: unknown;
      description?: unknown;
      is_popular?: unknown;
      is_featured?: unknown;
    };
    const duration = Number(row.duration_minutes) || 0;
    const buffer = Number(row.buffer_minutes) || 0;
    const totalMinutes = duration + buffer;
    const priceCentsRaw = row.price_cents;
    const priceCents =
      priceCentsRaw != null && Number.isFinite(Number(priceCentsRaw))
        ? Math.round(Number(priceCentsRaw))
        : null;

    const descRaw = row.description;
    const description =
      typeof descRaw === "string" && descRaw.trim().length > 0
        ? descRaw.trim()
        : null;

    return {
      id: row.id,
      name: row.name,
      durationMinutes: duration,
      bufferMinutes: buffer,
      totalMinutes,
      priceCents,
      priceDisplay: formatBookingPrice(priceCents, salonCurrency),
      category: parseServiceCategory(row.category),
      description,
      isPopular: row.is_popular === true,
      isFeatured: row.is_featured === true,
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
      // Task #04-C — `salons.timezone` is NOT NULL after migration
      // 20260512600000_timezone_required. The legacy "UTC" fallback
      // would have silently shipped 8-hour-offset booking times for
      // BC salons; we now fall back to empty string to surface the
      // missing data to the next consumer (booking page renders
      // "salon not ready" rather than wrong times).
      timezone: (() => {
        const tz = (salon as { timezone?: unknown }).timezone;
        const s = typeof tz === "string" ? tz.trim() : "";
        return s;
      })(),
      brandColor: normalizeBrandColor(
        (salon as { brand_color?: unknown }).brand_color,
      ),
      themeMode:
        (salon as { theme_mode?: unknown }).theme_mode === "light"
          ? "light"
          : "dark",
      currencyCode: salonCurrency,
      address: (() => {
        const a = (salon as { address?: unknown }).address;
        const s = typeof a === "string" ? a.trim() : "";
        return s.length > 0 ? s : null;
      })(),
      description: (() => {
        // `description` column added by migration 20260512100000. Cast
        // path tolerates a DB still on the prior schema by returning
        // null, so this never crashes a salon that hasn't migrated.
        const d = (salon as { description?: unknown }).description;
        const s = typeof d === "string" ? d.trim() : "";
        return s.length > 0 ? s : null;
      })(),
    },
  };
}
