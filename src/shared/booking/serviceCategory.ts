/**
 * Service-category helpers.
 *
 * The list used to be a hardcoded `as const` union; it now lives in
 * the `service_categories` table (see `loadServiceCategories.ts`).
 * `ServiceCategory` is therefore `string` — any slug the server has
 * accepted into the table is a valid value.
 *
 * Runtime validation against the live list happens in:
 *   - `addService` / `updateService` server actions (DB lookup before
 *     a write — see `setupActions.ts`)
 *   - the SuperAdmin add/update flows (uniqueness + non-empty checks)
 *
 * `parseServiceCategory` only does string-coercion + the default
 * fallback — it CANNOT enforce existence in the DB synchronously
 * (loaders are async). Callers who need that should use
 * `isKnownCategorySlug` from `loadServiceCategories.ts`.
 */

/** Any slug present in `service_categories.slug`. Treated as opaque
 *  by every consumer outside the loader / SuperAdmin CRUD. */
export type ServiceCategory = string;

/** Matches the seeded "other" row (sort_order 99). Used as the fallback
 *  whenever a service row's `category` is null / unknown so the public
 *  booking renderer always has a bucket to drop it into.
 *
 *  Renamed in P2.5: the "default" for a row's missing category is
 *  semantically distinct from the "default" for a freshly-opened add
 *  form — the form now starts on `ADD_FORM_DEFAULT_CATEGORY` (manicure)
 *  while orphan rows still land in `FALLBACK_SERVICE_CATEGORY` ("other"). */
export const FALLBACK_SERVICE_CATEGORY: ServiceCategory = "other";

/** P2.5 — initial category for a freshly opened "Add service" form.
 *  Most nail salons start with manicure as their flagship, so picking
 *  it cuts one tap from the common-case flow. */
export const ADD_FORM_DEFAULT_CATEGORY: ServiceCategory = "manicure";

/** @deprecated Use FALLBACK_SERVICE_CATEGORY (for orphan rows) or
 *  ADD_FORM_DEFAULT_CATEGORY (for the add form). Kept as an alias so
 *  any caller still importing the old name compiles. */
export const DEFAULT_SERVICE_CATEGORY = FALLBACK_SERVICE_CATEGORY;

export function parseServiceCategory(value: unknown): ServiceCategory {
  if (typeof value !== "string") return FALLBACK_SERVICE_CATEGORY;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : FALLBACK_SERVICE_CATEGORY;
}
