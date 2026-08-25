import type { SupabaseClient } from "@supabase/supabase-js";
import { cache } from "react";
import {
  fetchSimilarSalonSlugs,
  getSalonBySlug,
} from "@/shared/booking/getSalonBySlug";
import {
  loadBookingServicesForSalonSlug,
  type BookingLoadData,
} from "@/shared/booking/loadBookingServices";
import {
  normalizePublicBookingSlug,
  validatePublicBookingSlug,
} from "@/shared/booking/normalizePublicBookingSlug";
import { createPublicClient } from "@/shared/lib/supabase/publicClient";

/**
 * Paths that must not resolve as salon slugs.
 *
 * Two reasons a slug ends up here:
 *   (a) it shadows a literal `src/app/<name>/` route — Next.js routing
 *       picks the literal segment over `[slug]`, so a salon registered
 *       with this slug would be unreachable at `/<slug>` (and we want
 *       the wizard to refuse it before the row is even created); OR
 *   (b) it's a brand or shadow-route name we never want a salon to
   *       claim. Legacy wait URLs fail closed; current customer status links
   *       use action-scoped `/booking/status?token=...` capabilities.
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
  /**
   * The lookup FAILED — we do not know whether this salon exists.
   *
   * Distinct from `not_found`, and the distinction is load-bearing now that an
   * unknown slug answers with a real 404. `loadBookingServicesForSalonSlug`
   * returns `null` both when a salon is genuinely absent AND when the query
   * errors (it logs to NailIQ Error Monitor and returns null). Collapsing those two into
   * `not_found` meant a Supabase outage would serve 404 for every real,
   * paying salon — and Google de-indexes a 404. A failed lookup must surface
   * as a 5xx: "come back later", not "this never existed".
   */
  | { status: "error"; normalizedSlug: string; reason: string }
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

    // 4. Does this salon exist at all?
    //
    // Asked separately, and on purpose. loadBookingServicesForSalonSlug()
    // returns null for "no such salon" AND for "the query blew up" — it logs
    // the error to NailIQ Error Monitor and returns null either way. That conflation was
    // survivable while an unknown slug rendered a 200; it is not survivable now
    // that it renders a hard 404, because a Supabase blip would then hand
    // Google a 404 for tech-nails and hilite-anaheim and get them de-indexed.
    //
    // The exact public row is also threaded into the payload loader below so
    // this safety check does not become a duplicate lookup under load.
    const client = supabase ?? createPublicClient();
    const { salon: exists, error: lookupErr } = await getSalonBySlug(
      client,
      normalizedSlug,
    );

    if (lookupErr) {
      return {
        status: "error",
        normalizedSlug,
        reason: lookupErr.message,
      };
    }

    // 5. Genuinely absent → suggestions → not_found (a real 404).
    if (!exists) {
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

    // 6. It exists → load the full booking payload.
    //
    // A null now cannot mean "no such salon" — we just proved otherwise one
    // query ago. It means the load failed. Serving a 404 here would tell Google
    // a live salon is gone; a 5xx says "try again", which is the truth.
    const load = await loadBookingServicesForSalonSlug(
      normalizedSlug,
      client,
      exists,
    );
    if (!load) {
      return {
        status: "error",
        normalizedSlug,
        reason: "salon exists but its booking payload failed to load",
      };
    }

    // 7. if FOUND → check canonicalSlug → if mismatch → redirect
    if (load.canonicalSlug !== normalizedSlug) {
      return {
        status: "redirect",
        to: `/${load.canonicalSlug}`,
      };
    }

    // 8. return OK
    return {
      status: "ok",
      normalizedSlug: load.canonicalSlug,
      load,
    };
  },
);
