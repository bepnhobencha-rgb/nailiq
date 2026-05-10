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

/**
 * Paths that must not resolve as salon slugs.
 *
 * Two reasons a slug ends up here:
 *   (a) it shadows a literal `src/app/<name>/` route — Next.js routing
 *       picks the literal segment over `[slug]`, so a salon registered
 *       with this slug would be unreachable at `/<slug>` (and we want
 *       the wizard to refuse it before the row is even created); OR
 *   (b) it's a brand or shadow-route name we never want a salon to
 *       claim. `wait` lives at `/[slug]/wait/[bookingId]` so the naked
 *       `/wait` should never resolve as a salon.
 *
 * Keep this list in sync whenever a new top-level folder lands in
 * `src/app/` — a quick `ls src/app/` and add anything missing.
 */
export const RESERVED_BOOKING_SLUGS = new Set([
  // (a) shadow-protected — these are real Next routes.
  "api",
  "auth",
  "choose-salon",
  "contact",
  "dashboard",
  "debug-sentry",
  "login",
  "privacy",
  "register",
  "superadmin",
  "terms",
  // (b) brand- / path-protected.
  "aggressive",
  "wait",
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
