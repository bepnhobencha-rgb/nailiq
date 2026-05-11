/**
 * Per-salon brand color helpers (PR #109).
 *
 * Lives outside the dashboard / booking action trees because both the
 * server actions and the booking page consume it.
 */

/** Strict hex literal: leading `#` plus exactly 6 hex digits. Matches
 * the DB CHECK constraint in `salons_brand_color_hex_chk`. */
const BRAND_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/** Default — NailIQ gold. Falls back here when the column is missing
 * (pre-migration row) or the value fails validation. */
export const DEFAULT_BRAND_COLOR = "#D4AF37";

/** Suggested swatches surfaced under the color picker in Settings. */
export const BRAND_COLOR_PRESETS: ReadonlyArray<{
  hex: string;
  label: string;
}> = [
  { hex: "#D4AF37", label: "Gold" },
  { hex: "#E91E8C", label: "Pink" },
  { hex: "#9C27B0", label: "Purple" },
  { hex: "#00BCD4", label: "Teal" },
  { hex: "#1A1A1A", label: "Black" },
  { hex: "#E53935", label: "Red" },
];

export function isValidBrandColor(value: unknown): value is string {
  return typeof value === "string" && BRAND_COLOR_RE.test(value.trim());
}

/**
 * Coerces an arbitrary input to a valid `#RRGGBB` literal or the
 * default. Used when reading the column from the DB so downstream
 * components never see invalid data.
 */
export function normalizeBrandColor(input: unknown): string {
  if (typeof input !== "string") return DEFAULT_BRAND_COLOR;
  const trimmed = input.trim();
  if (BRAND_COLOR_RE.test(trimmed)) return trimmed.toUpperCase();
  return DEFAULT_BRAND_COLOR;
}
