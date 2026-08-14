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
  {
    value: "America/Vancouver",
    labelEn: "Vancouver — Pacific time (UTC−7 year-round)",
    labelVi: "Vancouver — giờ Thái Bình Dương (UTC−7 quanh năm)",
  },
  {
    value: "America/Dawson_Creek",
    labelEn: "Dawson Creek / Fort St. John — no DST",
    labelVi: "Dawson Creek / Fort St. John — không đổi giờ mùa hè",
  },
  {
    value: "America/Creston",
    labelEn: "Creston — no DST",
    labelVi: "Creston — không đổi giờ mùa hè",
  },
  { value: "America/Whitehorse", labelEn: "Whitehorse — Yukon", labelVi: "Whitehorse — Yukon" },
  { value: "America/Edmonton", labelEn: "Edmonton — Mountain time", labelVi: "Edmonton — giờ Miền Núi" },
  {
    value: "America/Winnipeg",
    labelEn: "Winnipeg — Central time",
    labelVi: "Winnipeg — giờ Miền Trung",
  },
  {
    value: "America/Regina",
    labelEn: "Regina — no DST",
    labelVi: "Regina — không đổi giờ mùa hè",
  },
  {
    value: "America/Toronto",
    labelEn: "Toronto — Eastern time",
    labelVi: "Toronto — giờ Miền Đông",
  },
  {
    value: "America/Atikokan",
    labelEn: "Atikokan — Eastern, no DST",
    labelVi: "Atikokan — giờ Miền Đông, không đổi giờ mùa hè",
  },
  { value: "America/Halifax", labelEn: "Halifax — Atlantic time", labelVi: "Halifax — giờ Đại Tây Dương" },
  {
    value: "America/Blanc-Sablon",
    labelEn: "Blanc-Sablon — Atlantic, no DST",
    labelVi: "Blanc-Sablon — giờ Đại Tây Dương, không đổi giờ mùa hè",
  },
  {
    value: "America/St_Johns",
    labelEn: "St. John’s — Newfoundland time",
    labelVi: "St. John’s — giờ Newfoundland",
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
