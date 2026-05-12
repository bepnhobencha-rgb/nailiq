/**
 * Per-render cached loader for the platform's service-category list.
 *
 * Categories used to be a hardcoded TypeScript union; they now live in
 * the `service_categories` table (slug + name_en + name_vi + sort_order
 * + soft-delete) so SuperAdmin can add / rename / retire categories
 * without a deploy. Every render path that displays a category label —
 * the public booking page (`/[slug]`), the setup wizard
 * (`/dashboard/[slug]/setup/services`), and the SuperAdmin panel —
 * reads from this loader.
 *
 * `cache()` from React de-duplicates concurrent calls inside a single
 * Server Component render pass: the booking page and a parallel loader
 * both call `loadServiceCategories()` once, share the result, and the
 * second call is free. The cache resets between requests, so SuperAdmin
 * edits show up on the next page render with no manual invalidation.
 */
import { cache } from "react";

import { createClient } from "@/shared/lib/supabase/server";

export type ServiceCategorySummary = {
  /** Stable identifier persisted on `services.category`. */
  slug: string;
  /** Display label for English locales. */
  nameEn: string;
  /** Display label for Vietnamese locales. */
  nameVi: string;
  /** Lower numbers render first. NULL / unset rows render after
   *  explicitly-ordered ones via the secondary slug sort. */
  sortOrder: number;
};

/** The slug used as a fallback when a service row carries an unknown
 *  / null category. Matches the seeded "other" row (sort_order 99). */
export const FALLBACK_CATEGORY_SLUG = "other";

export const loadServiceCategories = cache(
  async (): Promise<ServiceCategorySummary[]> => {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("service_categories")
      .select("slug, name_en, name_vi, sort_order")
      .is("deleted_at" as never, null)
      .order("sort_order", { ascending: true })
      .order("slug", { ascending: true });

    if (error) {
      console.error("[loadServiceCategories]", error);
      return [];
    }

    // QA bug (2026-05-12): two "Other" accordions appeared on the
    // booking page even though prod only has one row. The duplicate
    // was traced to the display layer, but a paranoid loader-level
    // dedupe is cheap insurance against any future seed/migration
    // accidentally re-inserting a colliding slug. First-wins keeps
    // the lowest sort_order entry (we already ordered by sort_order
    // ASC, slug ASC).
    const seenSlug = new Set<string>();
    const out: ServiceCategorySummary[] = [];
    for (const row of data ?? []) {
      const r = row as unknown as {
        slug: string;
        name_en?: string | null;
        name_vi?: string | null;
        sort_order?: number | null;
      };
      const slug = String(r.slug ?? "").trim();
      if (!slug || seenSlug.has(slug)) continue;
      seenSlug.add(slug);
      out.push({
        slug,
        nameEn: String(r.name_en ?? slug).trim(),
        nameVi: String(r.name_vi ?? r.name_en ?? slug).trim(),
        sortOrder: Number.isFinite(Number(r.sort_order))
          ? Number(r.sort_order)
          : 0,
      });
    }
    return out;
  },
);

/** Strict — only returns the row when the slug currently exists and is
 *  not soft-deleted. Used by server actions to validate a save before
 *  writing. */
export async function isKnownCategorySlug(slug: string): Promise<boolean> {
  if (!slug.trim()) return false;
  const categories = await loadServiceCategories();
  return categories.some((c) => c.slug === slug);
}
