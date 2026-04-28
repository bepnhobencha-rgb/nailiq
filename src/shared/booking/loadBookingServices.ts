import type { BookingServiceItem } from "@/shared/booking/catalog";
import { createClient } from "@/shared/lib/supabase/server";

/**
 * Loads bookable services for a public salon URL slug.
 * Returns `null` if the salon does not exist.
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

  if (salonErr || !salon) {
    return null;
  }

  const { data: rows, error: servicesErr } = await supabase
    .from("services")
    .select("id, name")
    .eq("salon_id", salon.id)
    .order("name", { ascending: true });

  if (servicesErr) {
    return [];
  }

  return (rows ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
  }));
}
