import { cache } from "react";
import { fetchSimilarSalonSlugs } from "@/shared/booking/getSalonBySlug";
import {
  loadBookingServicesForSalonSlug,
  type BookingLoadData,
} from "@/shared/booking/loadBookingServices";
import { normalizePublicBookingSlug } from "@/shared/booking/normalizePublicBookingSlug";
import { createClient } from "@/shared/lib/supabase/server";

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
  | { status: "ok"; normalizedSlug: string; load: BookingLoadData };

export const resolvePublicBookingPage = cache(
  async (rawSlug: string): Promise<ResolvedPublicBookingPage> => {
    const normalizedSlug = normalizePublicBookingSlug(rawSlug);
    if (RESERVED_BOOKING_SLUGS.has(normalizedSlug)) {
      return { status: "reserved" };
    }

    const load = await loadBookingServicesForSalonSlug(normalizedSlug);

    console.log("[TRACK]", {
      event: "booking_page_view",
      slug: normalizedSlug,
      found: !!load,
    });

    if (!load) {
      const supabase = await createClient();
      const suggestedSlugs = await fetchSimilarSalonSlugs(
        supabase,
        normalizedSlug,
      );
      return {
        status: "not_found",
        normalizedSlug,
        suggestedSlugs:
          suggestedSlugs.length > 0 ? suggestedSlugs : undefined,
      };
    }

    return {
      status: "ok",
      normalizedSlug: load.canonicalSlug,
      load,
    };
  },
);
