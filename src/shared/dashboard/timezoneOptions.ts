/**
 * Canonical timezone list for the salon-setup address panel.
 *
 * Locked to canonical IANA names that cover the Canadian provinces +
 * continental US — the primary beta markets. New entries are an
 * intentional product decision, not a free-form text field, because
 * salon time math (`salonTime.ts`, `loadGroupSmartSchedule.ts`,
 * `submitPublicBooking.ts`) treats `timezone` as a load-bearing
 * input and tolerates ZERO typos.
 *
 * Storage shape: `salons.timezone TEXT NOT NULL DEFAULT
 * 'America/Vancouver'` (see migration `20260512600000_timezone_required`).
 * Validator + UI both consume from this list, so a salon owner can
 * never persist a value that downstream code wouldn't understand.
 */

export type SetupTimezoneOption = {
  /** IANA zone identifier — exactly what `Intl.DateTimeFormat` accepts. */
  value: string;
  labelEn: string;
  labelVi: string;
};

export const SETUP_TIMEZONE_OPTIONS = [
  { value: "America/Vancouver", labelEn: "BC", labelVi: "BC" },
  { value: "America/Whitehorse", labelEn: "Yukon", labelVi: "Yukon" },
  { value: "America/Edmonton", labelEn: "Alberta", labelVi: "Alberta" },
  {
    value: "America/Winnipeg",
    labelEn: "Manitoba",
    labelVi: "Manitoba",
  },
  {
    value: "America/Regina",
    labelEn: "Saskatchewan",
    labelVi: "Saskatchewan",
  },
  {
    value: "America/Toronto",
    labelEn: "Ontario, Quebec",
    labelVi: "Ontario, Quebec",
  },
  { value: "America/Halifax", labelEn: "Atlantic", labelVi: "Atlantic" },
  {
    value: "America/St_Johns",
    labelEn: "Newfoundland",
    labelVi: "Newfoundland",
  },
  { value: "America/New_York", labelEn: "US East", labelVi: "Mỹ — Đông" },
  { value: "America/Chicago", labelEn: "US Central", labelVi: "Mỹ — Trung" },
  { value: "America/Denver", labelEn: "US Mountain", labelVi: "Mỹ — Núi" },
  {
    value: "America/Los_Angeles",
    labelEn: "US Pacific",
    labelVi: "Mỹ — Tây",
  },
] as const satisfies ReadonlyArray<SetupTimezoneOption>;

/** Fallback baseline. Used by the DB column DEFAULT and by the UI
 *  when an unknown legacy value is detected (so the dropdown still
 *  has a real selection). Vancouver because beta tenants concentrate
 *  in BC. */
export const SETUP_TIMEZONE_DEFAULT: SetupTimezone = "America/Vancouver";

export type SetupTimezone = (typeof SETUP_TIMEZONE_OPTIONS)[number]["value"];

export function isAllowedTimezone(value: unknown): value is SetupTimezone {
  if (typeof value !== "string") return false;
  return (SETUP_TIMEZONE_OPTIONS as readonly SetupTimezoneOption[]).some(
    (o) => o.value === value,
  );
}
