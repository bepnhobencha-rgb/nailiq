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

import { createPublicClient } from "@/shared/lib/supabase/publicClient";

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

const CATEGORY_SLUG_RE = /^[a-z][a-z0-9_]{1,39}$/;
const CATEGORY_NAME_MAX_LENGTH = 80;

type ServiceCategoryQueryResult = {
  data: unknown[] | null;
  error: unknown;
};

type ServiceCategoryQuery = PromiseLike<ServiceCategoryQueryResult> & {
  is(column: string, value: null): ServiceCategoryQuery;
  order(
    column: string,
    options: { ascending: boolean; nullsFirst?: boolean },
  ): ServiceCategoryQuery;
};

export type ServiceCategoryReadClient = {
  from(table: "service_categories"): {
    select(columns: string): ServiceCategoryQuery;
  };
};

function categoryLoadFailure(code: string, cause?: unknown): Error {
  return new Error(code, cause === undefined ? undefined : { cause });
}

/**
 * Strict, stateless public read used by the cached Server Component loader and
 * executable tests. Category rows are platform taxonomy; tenant isolation is
 * applied by the separate salon-scoped service query before grouping.
 */
export async function loadServiceCategoriesFromClient(
  client: ServiceCategoryReadClient,
): Promise<ServiceCategorySummary[]> {
  const { data, error } = await client
    .from("service_categories")
    .select("slug, name_en, name_vi, sort_order")
    .is("deleted_at", null)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("slug", { ascending: true });

  if (error) {
    throw categoryLoadFailure("service_categories_unavailable", error);
  }
  if (!Array.isArray(data) || data.length === 0) {
    throw categoryLoadFailure("service_categories_empty");
  }

  const seenSlug = new Set<string>();
  const out: ServiceCategorySummary[] = [];
  for (const value of data) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw categoryLoadFailure("service_category_invalid");
    }
    const row = value as Record<string, unknown>;
    const slug = typeof row.slug === "string" ? row.slug.trim() : "";
    const nameEn = typeof row.name_en === "string" ? row.name_en.trim() : "";
    const nameVi = typeof row.name_vi === "string" ? row.name_vi.trim() : "";
    const sortOrder =
      row.sort_order == null
        ? Number.MAX_SAFE_INTEGER
        : typeof row.sort_order === "number" &&
            Number.isSafeInteger(row.sort_order)
          ? row.sort_order
          : null;
    if (
      !CATEGORY_SLUG_RE.test(slug) ||
      !nameEn ||
      nameEn.length > CATEGORY_NAME_MAX_LENGTH ||
      !nameVi ||
      nameVi.length > CATEGORY_NAME_MAX_LENGTH ||
      sortOrder == null ||
      seenSlug.has(slug)
    ) {
      throw categoryLoadFailure("service_category_invalid");
    }
    seenSlug.add(slug);
    out.push({ slug, nameEn, nameVi, sortOrder });
  }

  return out.sort((a, b) => {
    const position = a.sortOrder - b.sortOrder;
    if (position !== 0) return position;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
}

export const loadServiceCategories = cache(
  async (): Promise<ServiceCategorySummary[]> => {
    const client = createPublicClient();
    return loadServiceCategoriesFromClient(
      client as unknown as ServiceCategoryReadClient,
    );
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
