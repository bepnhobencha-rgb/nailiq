/**
 * Service short display names for compact timeline blocks (P1 readability).
 *
 * Display-only — never mutates booking/service data. The full service name
 * always remains the source of truth and is shown in the detail drawer and
 * the block's hover tooltip.
 *
 * Resolution order (configurable-first, per the no-hardcode rule):
 *   1. An explicit override map (future: salon-level Admin Advanced Settings,
 *      or a `services.short_name` column). Callers pass it in via `overrides`.
 *   2. A conservative built-in abbreviation map of common nail-salon services
 *      (safe defaults, case-insensitive).
 *   3. A length-based fallback: short names pass through unchanged; long names
 *      are returned as-is (NEVER lossily truncated here — the block itself
 *      handles overflow with CSS).
 *
 * The built-in map is intentionally small and generic. Salon-specific aliases
 * belong in config, not here — this is only a graceful default so blocks read
 * better before any salon configures their own.
 */

/** Built-in conservative abbreviations (lowercased keys, exact match). */
const DEFAULT_SHORT_NAMES: Record<string, string> = {
  "acrylic fill": "Acr Fill",
  "acrylic full set": "Acr Full Set",
  "acrylic ombre": "Acr Ombre",
  "gel manicure": "Gel Mani",
  "gel pedicure": "Gel Pedi",
  "gel french tips": "Gel French",
  "gel remove + redo": "Gel Redo",
  "classic manicure": "Classic Mani",
  "french manicure": "French Mani",
  "kids manicure": "Kids Mani",
  "pedicure classic": "Pedi Classic",
  "pedicure": "Pedi",
  "spa pedicure deluxe": "Spa Pedi Deluxe",
  "hot stone pedicure": "Hot Stone Pedi",
  "chrome powder nails": "Chrome Powder",
  "dip powder": "Dip Powder",
  "dip french": "Dip French",
  "nail art (per nail)": "Nail Art",
  "nail repair (per nail)": "Nail Repair",
  "eyebrow wax": "Brow Wax",
  "upper lip wax": "Lip Wax",
};

/**
 * Return a compact display name for a service.
 *
 * @param fullName  The full service name (display source of truth).
 * @param overrides Optional salon/admin-configured alias map. Keys are matched
 *                  case-insensitively against the trimmed full name and win
 *                  over the built-in defaults.
 */
export function serviceShortName(
  fullName: string,
  overrides?: Record<string, string>,
): string {
  const trimmed = (fullName ?? "").trim();
  if (!trimmed) return trimmed;

  const key = trimmed.toLowerCase();

  // 1. Caller-supplied overrides (future Admin Advanced Settings / DB column).
  if (overrides) {
    const hit = overrides[key] ?? overrides[trimmed];
    if (hit && hit.trim()) return hit.trim();
  }

  // 2. Built-in conservative defaults.
  const builtin = DEFAULT_SHORT_NAMES[key];
  if (builtin) return builtin;

  // 3. Fallback: return the full name unchanged (block handles overflow).
  return trimmed;
}
