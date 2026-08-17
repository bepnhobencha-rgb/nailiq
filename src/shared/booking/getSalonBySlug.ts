import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PUBLIC_BOOKING_SLUG_MAX_LEN,
  PUBLIC_BOOKING_SLUG_MIN_LEN,
} from "@/shared/booking/normalizePublicBookingSlug";

// Keep this list aligned with the anonymous column grant in
// 20260722214100_harden_public_salon_reads.sql. Public booking must never use
// select("*") here: salons also stores owner contact, billing and internal AI
// configuration.
export const PUBLIC_BOOKING_SALON_SELECT = [
  "id", "slug", "name", "address", "salon_phone", "opening_hours",
  "profile_complete", "booking_closed_dates", "closure_notice", "timezone",
  "subscription_plan", "plan_override", "feature_flags", "brand_color",
  "theme_mode", "currency_code", "description", "phone_otp_enabled",
  "voice_ai_enabled", "vertical", "public_sections_enabled", "booking_images",
  "staff_selection_enabled", "booking_lead_minutes",
  "group_together_threshold_minutes", "reference_image_enabled",
  "health_ack_required", "email_links_enabled", "resources_enabled",
  "tax_lines", "privacy_url", "terms_url", "default_language", "logo_url",
].join(", ");

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
    .from("public_salon_profiles" as never)
    .select(PUBLIC_BOOKING_SALON_SELECT as never)
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
      salon: salonExact as unknown as Record<string, unknown>,
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
