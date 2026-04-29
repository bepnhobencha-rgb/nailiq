import type { SupabaseClient } from "@supabase/supabase-js";
import { cache } from "react";
import { fetchSimilarSalonSlugs } from "@/shared/booking/getSalonBySlug";
import {
  loadBookingServicesForSalonSlug,
  type BookingLoadData,
} from "@/shared/booking/loadBookingServices";
import {
  normalizePublicBookingSlug,
  validatePublicBookingSlug,
} from "@/shared/booking/normalizePublicBookingSlug";
import { createClient } from "@/shared/lib/supabase/server";
import { setPublicBookingSalonTags } from "@/shared/observability/salonSentry";

/** Paths that must not resolve as salon slugs (overlap static routes or reserved names). */
export const RESERVED_BOOKING_SLUGS = new Set([
  "login",
  "register",
  "dashboard",
  "api",
  "aggressive",
]);

export type ResolvedPublicBookingPage =
  | { status: "reserved" }
  | {
      status: "not_found";
      normalizedSlug: string;
      suggestedSlugs?: string[];
    }
  | { status: "redirect"; to: string }
  | { status: "ok"; normalizedSlug: string; load: BookingLoadData };

// NOTE:
// cache() may cause stale NOT_FOUND after new salon creation.
// Consider removing or bypassing cache for not_found in future.
export const resolvePublicBookingPage = cache(
  async (
    rawSlug: string,
    supabase?: SupabaseClient,
  ): Promise<ResolvedPublicBookingPage> => {
    // 1. normalize slug
    const normalizedSlug = normalizePublicBookingSlug(rawSlug);

    // 2. validate slug
    if (!validatePublicBookingSlug(normalizedSlug)) {
      return {
        status: "not_found",
        normalizedSlug,
      };
    }

    // 3. check reserved slug
    if (RESERVED_BOOKING_SLUGS.has(normalizedSlug)) {
      return { status: "reserved" };
    }

    // 4. load booking data
    const load = await loadBookingServicesForSalonSlug(normalizedSlug, supabase);

    // 5. if NOT FOUND → fetch suggestions → return not_found
    if (!load) {
      const client = supabase ?? (await createClient());
      const rawSuggestions = await fetchSimilarSalonSlugs(
        client,
        normalizedSlug,
      );
      const suggestedSlugs = rawSuggestions
        .filter((s) => s && s !== normalizedSlug)
        .slice(0, 3);

      return {
        status: "not_found",
        normalizedSlug,
        suggestedSlugs:
          suggestedSlugs.length > 0 ? suggestedSlugs : undefined,
      };
    }

    // 7. if FOUND → check canonicalSlug → if mismatch → redirect
    if (load.canonicalSlug !== normalizedSlug) {
      return {
        status: "redirect",
        to: `/${load.canonicalSlug}`,
      };
    }

    setPublicBookingSalonTags({
      salonId: load.salon.id,
      salonSlug: load.canonicalSlug,
      salonName: load.salon.name,
    });

    // 8. return OK
    return {
      status: "ok",
      normalizedSlug: load.canonicalSlug,
      load,
    };
  },
);
