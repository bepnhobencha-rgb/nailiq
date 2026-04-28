import type { BookingServiceItem } from "@/shared/booking/catalog";
import { createClient } from "@/shared/lib/supabase/server";

/**
 * Loads bookable services for a public salon URL slug.
 * Returns `null` if the salon does not exist.
 *
 * Uses `createClient()` from `@/shared/lib/supabase/server` — anon publishable key + cookies
 * (not the service role). Public catalog reads rely on RLS policies for anonymous access.
 */
export async function loadBookingServicesForSalonSlug(
  shopSlug: string,
): Promise<BookingServiceItem[] | null> {
  const supabase = await createClient();

  const { data: salon, error: salonErr } = await supabase
    .from("salons")
    .select("id")
    .eq("slug", shopSlug)
    .maybeSingle();

  if (salonErr) {
    console.error("loadBookingServices error:", salonErr);
    return null;
  }
  if (!salon) {
    return null;
  }

  const { data: rows, error: servicesErr } = await supabase
    .from("services")
    .select("id, name, duration_minutes, buffer_minutes")
    .eq("salon_id", salon.id)
    .order("name", { ascending: true });

  if (servicesErr) {
    console.error("loadBookingServices error:", servicesErr);
    return [];
  }

  return (rows ?? []).map((r) => {
    const duration = Number(r.duration_minutes) || 0;
    const buffer = Number(r.buffer_minutes) || 0;
    const totalMinutes = duration + buffer;

    return {
      id: r.id as string,
      name: r.name as string,
      totalMinutes,
      /** Wire `price_cents` (or similar) in select + map when the column exists. */
      priceDisplay: null as string | null,
    };
  });
}
