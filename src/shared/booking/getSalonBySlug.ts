import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PUBLIC_BOOKING_SLUG_MAX_LEN,
  PUBLIC_BOOKING_SLUG_MIN_LEN,
} from "@/shared/booking/normalizePublicBookingSlug";

export async function getSalonBySlug(
  supabase: SupabaseClient,
  slug: string,
): Promise<{
  salon: Record<string, unknown> | null;
  error: { message: string; code?: string } | null;
}> {
  const normalizedSlug = slug.trim().toLowerCase();

  if (
    normalizedSlug.length < PUBLIC_BOOKING_SLUG_MIN_LEN ||
    normalizedSlug.length > PUBLIC_BOOKING_SLUG_MAX_LEN
  ) {
    return { salon: null, error: null };
  }

  const { data: salonExact, error: exactErr } = await supabase
    .from("salons")
    .select("*")
    .eq("slug", normalizedSlug)
    .limit(1)
    .maybeSingle();

  if (exactErr) {
    return {
      salon: null,
      error: { message: exactErr.message, code: exactErr.code },
    };
  }
  if (salonExact) {
    return {
      salon: salonExact as Record<string, unknown>,
      error: null,
    };
  }

  return { salon: null, error: null };
}

/** Top similar slugs by pg_trgm (empty if RPC unavailable). Booking flowchart step 6 — after `booking_not_found`. */
export async function fetchSimilarSalonSlugs(
  supabase: SupabaseClient,
  inputSlug: string,
): Promise<string[]> {
  const q = inputSlug.trim();
  if (q.length < PUBLIC_BOOKING_SLUG_MIN_LEN) return [];

  const { data, error } = await supabase.rpc("suggest_salon_slugs_by_similarity", {
    p_input: q,
  });

  if (error) {
    console.warn("[PUBLIC_BOOKING] suggest_salon_slugs", error.message);
    return [];
  }
  if (!Array.isArray(data)) return [];
  return (data as unknown[])
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);
}
