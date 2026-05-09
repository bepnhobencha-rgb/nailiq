/**
 * Receptionist desk density (Simple ↔ Balanced ↔ Pro).
 *
 * Orthogonal to `dashboard_preset` (zone layout) and `dashboard_modules`
 * (feature flags). Density tunes **visual rhythm** only — booking-block
 * min height, label visibility, skill row visibility, slot granularity
 * — without altering the three-zone layout per
 * `docs/DASHBOARD_LAYOUT_RULES.md`.
 *
 * Spacing maps to `docs/DESIGN_SYSTEM.md §1` tokens (`space-1`–`space-9`)
 * via the consuming components — values here describe **intent in
 * pixels**, but consumers should map to tailwind utility classes that
 * trace to those tokens; raw pixel values appear here only for the
 * height/duration knobs that aren't on the spacing scale.
 *
 * Time-slot granularity at the data level remains 30-minute slots (the
 * `salon_hours` cadence and `bookings_no_overlap` GIST contract). The
 * `timeSlotMinutes` knob below is **visual only** — it tunes vertical
 * row height in the timeline, not the slot count or booking math. Pro
 * users see denser rows; Simple users see taller rows for easier touch.
 */

export const DENSITY_LEVELS = ["simple", "balanced", "pro"] as const;
export type DensityLevel = (typeof DENSITY_LEVELS)[number];

export const DEFAULT_DENSITY: DensityLevel = "balanced";

export interface DensityConfig {
  /** Min height in pixels for a booking block (visual only — schedule math unchanged). */
  bookingBlockMinHeight: number;
  /**
   * Show the secondary meta line on booking blocks (service name + price).
   * Off in Simple to keep blocks calm; on otherwise.
   */
  showMetaLine: boolean;
  /**
   * Render `$price` segment inside booking blocks. Composes with
   * `dashboard_modules.revenue_today` — both must be true for the price
   * to render.
   */
  showPriceInBlock: boolean;
  /**
   * Render `StaffAvatar` skills row in the staff column. Composes with
   * `dashboard_modules.staff_performance` — both must be true. Off in
   * Simple to reduce chrome; on in Balanced/Pro.
   */
  showSkillBadges: boolean;
  /**
   * Visual slot height bucket — affects vertical pixel height of timeline
   * rows. Schedule slot count + booking math remain on the salon's true
   * cadence (30 min). Pro users see denser vertical rhythm.
   */
  timeSlotMinutes: 20 | 30 | 40;
}

/**
 * Pre-baked configs per density. Adjusting these knobs requires
 * verification against `DASHBOARD_LAYOUT_RULES §6` ("must always be
 * visible") — staff names, NOW line, and time scale are never collapsed
 * by density.
 */
export const DENSITY_CONFIG: Record<DensityLevel, DensityConfig> = {
  simple: {
    bookingBlockMinHeight: 56,
    showMetaLine: false,
    showPriceInBlock: false,
    showSkillBadges: false,
    timeSlotMinutes: 40,
  },
  balanced: {
    bookingBlockMinHeight: 44,
    showMetaLine: true,
    showPriceInBlock: true,
    showSkillBadges: true,
    timeSlotMinutes: 30,
  },
  pro: {
    bookingBlockMinHeight: 36,
    showMetaLine: true,
    showPriceInBlock: true,
    showSkillBadges: true,
    timeSlotMinutes: 20,
  },
};

export function isDensityLevel(value: unknown): value is DensityLevel {
  return (
    typeof value === "string" &&
    (DENSITY_LEVELS as readonly string[]).includes(value)
  );
}

/** Robust narrow at boundaries (DB row reads, server-action input). */
export function parseDensityLevel(value: unknown): DensityLevel {
  return isDensityLevel(value) ? value : DEFAULT_DENSITY;
}

export function densityConfigFor(level: DensityLevel): DensityConfig {
  return DENSITY_CONFIG[level];
}
