// Supported countries for the public-booking phone input + helpers to default
// the picker from the salon's location. Pure & dependency-free so it can be
// unit-tested and imported on both server and client.
//
// Ordering is deliberate: the North America cluster (US, Canada, Mexico) comes
// first because those markets share customers who cross borders, then the UK,
// then Eurozone countries, then Vietnam (kept for diaspora salons). The salon's
// own country is surfaced first at render time via `defaultPhoneCountry()`.

export type PhoneCountry = {
  /** ISO 3166-1 alpha-2 — also the libphonenumber region for validation. */
  iso: string;
  /** Calling code digits, without the leading "+". */
  dial: string;
  /** English display name. */
  name: string;
  /** Vietnamese display name. */
  nameVi: string;
  /** National-format example, used as the input placeholder. */
  example: string;
};

export const PHONE_COUNTRIES: readonly PhoneCountry[] = [
  // North America (cross-border cluster, on top)
  { iso: "US", dial: "1", name: "United States", nameVi: "Hoa Kỳ", example: "(213) 555-0123" },
  { iso: "CA", dial: "1", name: "Canada", nameVi: "Canada", example: "(604) 555-0123" },
  { iso: "MX", dial: "52", name: "Mexico", nameVi: "Mexico", example: "55 1234 5678" },
  // United Kingdom (GBP, not Eurozone)
  { iso: "GB", dial: "44", name: "United Kingdom", nameVi: "Anh", example: "7700 900123" },
  // Eurozone
  { iso: "FR", dial: "33", name: "France", nameVi: "Pháp", example: "6 12 34 56 78" },
  { iso: "DE", dial: "49", name: "Germany", nameVi: "Đức", example: "151 23456789" },
  { iso: "ES", dial: "34", name: "Spain", nameVi: "Tây Ban Nha", example: "612 34 56 78" },
  { iso: "IT", dial: "39", name: "Italy", nameVi: "Ý", example: "312 345 6789" },
  { iso: "NL", dial: "31", name: "Netherlands", nameVi: "Hà Lan", example: "6 12345678" },
  { iso: "IE", dial: "353", name: "Ireland", nameVi: "Ireland", example: "85 012 3456" },
  { iso: "BE", dial: "32", name: "Belgium", nameVi: "Bỉ", example: "470 12 34 56" },
  { iso: "PT", dial: "351", name: "Portugal", nameVi: "Bồ Đào Nha", example: "912 345 678" },
  { iso: "AT", dial: "43", name: "Austria", nameVi: "Áo", example: "664 123456" },
  // Vietnam (diaspora salons)
  { iso: "VN", dial: "84", name: "Vietnam", nameVi: "Việt Nam", example: "90 123 4567" },
];

/** Fallback when the salon's timezone doesn't map to a supported country. */
export const DEFAULT_PHONE_ISO = "US";

/** IANA timezone → ISO country, used to default the picker from salon location
 *  (the salon stores `timezone`, not a structured country column). Only the
 *  zones for supported countries are listed; anything else falls back. */
const TIMEZONE_TO_ISO: Readonly<Record<string, string>> = {
  // United States
  "America/Los_Angeles": "US",
  "America/Denver": "US",
  "America/Phoenix": "US",
  "America/Chicago": "US",
  "America/New_York": "US",
  "America/Detroit": "US",
  "America/Anchorage": "US",
  "Pacific/Honolulu": "US",
  // Canada
  "America/Toronto": "CA",
  "America/Vancouver": "CA",
  "America/Edmonton": "CA",
  "America/Winnipeg": "CA",
  "America/Halifax": "CA",
  "America/St_Johns": "CA",
  "America/Regina": "CA",
  // Mexico
  "America/Mexico_City": "MX",
  "America/Tijuana": "MX",
  "America/Monterrey": "MX",
  "America/Cancun": "MX",
  "America/Merida": "MX",
  // United Kingdom + Ireland
  "Europe/London": "GB",
  "Europe/Dublin": "IE",
  // Eurozone
  "Europe/Paris": "FR",
  "Europe/Berlin": "DE",
  "Europe/Madrid": "ES",
  "Europe/Rome": "IT",
  "Europe/Amsterdam": "NL",
  "Europe/Brussels": "BE",
  "Europe/Lisbon": "PT",
  "Europe/Vienna": "AT",
  // Vietnam
  "Asia/Ho_Chi_Minh": "VN",
  "Asia/Saigon": "VN",
};

export function countryByIso(iso: string): PhoneCountry | undefined {
  const target = iso.toUpperCase();
  return PHONE_COUNTRIES.find((c) => c.iso === target);
}

/** Resolve the default country for the picker from the salon's timezone.
 *  Always returns a supported country (falls back to US). */
export function defaultPhoneCountry(timezone?: string | null): PhoneCountry {
  const iso = (timezone && TIMEZONE_TO_ISO[timezone]) || DEFAULT_PHONE_ISO;
  return countryByIso(iso) ?? countryByIso(DEFAULT_PHONE_ISO)!;
}

/** Combine a selected country + the national number the user typed into the
 *  `+<dial><national>` form that `validateGuestPhone` / `formatPhoneInputProgressive`
 *  already understand. Strips a single national trunk "0" (UK/EU local form). */
export function toE164Input(country: PhoneCountry, nationalRaw: string): string {
  const national = nationalRaw.replace(/\D/g, "").replace(/^0+/, "");
  if (national.length === 0) return "";
  return `+${country.dial}${national}`;
}
