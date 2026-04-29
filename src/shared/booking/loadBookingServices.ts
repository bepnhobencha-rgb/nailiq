import type { BookingServiceItem } from "@/shared/booking/catalog";
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
};

export type BookingLoadData = {
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
  const supabase = await createClient();

  const { data: salon, error: salonErr } = await supabase
    .from("salons")
    .select("id, name, opening_hours")
    .eq("slug", shopSlug)
    .maybeSingle();

  if (salonErr) {
    console.error("loadBookingServices error:", salonErr);
    return null;
  }
  if (!salon) {
    return null;
  }

  const salonId = salon.id as string;

  const { data: rows, error: servicesErr } = await supabase
    .from("services")
    .select("id, name, duration_minutes, buffer_minutes")
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

    return {
      id: r.id as string,
      name: r.name as string,
      totalMinutes,
      /** Wire `price_cents` (or similar) in select + map when surfaced on tiles. */
      priceDisplay: null as string | null,
    };
  });

  const staff: BookingStaffItem[] = (staffList ?? []).map((s) => ({
    id: String(s.id),
    name: String(s.name ?? ""),
    job_role: String(s.job_role ?? ""),
  }));

  return {
    services,
    staff,
    salon: {
      id: salonId,
      name: String((salon as { name?: string }).name ?? ""),
      opening_hours: (salon as { opening_hours?: unknown }).opening_hours ?? null,
    },
  };
}
