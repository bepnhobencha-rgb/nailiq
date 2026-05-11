/**
 * Service category — single source of truth for the IDs that match the
 * DB CHECK constraint in
 * `supabase/migrations/20260511500000_add_service_category.sql`, plus
 * the canonical display order used by the public booking page and the
 * setup-wizard menu.
 *
 * Labels are intentionally NOT in this file — those live in the i18n
 * bundles (`booking/en.ts` for the public surface, `user/{en,vi}.ts`
 * for the owner dashboard) so the language switcher keeps working.
 */

export const SERVICE_CATEGORIES = [
  "manicure",
  "pedicure",
  "acrylic",
  "gel",
  "dip",
  "waxing",
  "other",
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export const DEFAULT_SERVICE_CATEGORY: ServiceCategory = "other";

export function isServiceCategory(value: unknown): value is ServiceCategory {
  return (
    typeof value === "string" &&
    (SERVICE_CATEGORIES as readonly string[]).includes(value)
  );
}

export function parseServiceCategory(value: unknown): ServiceCategory {
  return isServiceCategory(value) ? value : DEFAULT_SERVICE_CATEGORY;
}
