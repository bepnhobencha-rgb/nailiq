// Worldwide country list for the public-booking phone input + helpers to default
// the picker from the salon's location.
//
// The country list (ISO + dial code) is built from libphonenumber-js metadata
// (~245 regions) so EVERY country is selectable — no hand-maintained list to
// fall out of date. Display names come from Intl.DisplayNames (English +
// Vietnamese). A few high-traffic markets are floated to the top for usability;
// the rest are alphabetical. The default country is resolved from the salon's
// timezone (the salon stores `timezone`, not a structured country column).

import { getCountries, getCountryCallingCode } from "libphonenumber-js/core";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import metadata from "libphonenumber-js/metadata.min.json";

export type PhoneCountry = {
  /** ISO 3166-1 alpha-2 — also the libphonenumber region for validation. */
  iso: string;
  /** Calling code digits, without the leading "+". */
  dial: string;
  /** English display name. */
  name: string;
  /** Vietnamese display name. */
  nameVi: string;
};

/** Markets floated to the top of the picker for quick access (NailIQ's core
 *  regions + a few common ones). Everything else follows, alphabetical. */
const PRIORITY_ISO = ["US", "CA", "MX", "GB", "FR", "DE", "ES", "IT", "NL", "AU", "SG", "VN"];

function buildCountries(): PhoneCountry[] {
  let enNames: Intl.DisplayNames | null = null;
  let viNames: Intl.DisplayNames | null = null;
  try {
    enNames = new Intl.DisplayNames(["en"], { type: "region" });
    viNames = new Intl.DisplayNames(["vi"], { type: "region" });
  } catch {
    /* Intl.DisplayNames unavailable — fall back to ISO codes as names. */
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isoList = getCountries(metadata as any) as string[];
  const list: PhoneCountry[] = [];
  for (const iso of isoList) {
    let dial: string;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dial = getCountryCallingCode(iso as any, metadata as any) as string;
    } catch {
      continue;
    }
    const name = enNames?.of(iso) ?? iso;
    const nameVi = viNames?.of(iso) ?? name;
    list.push({ iso, dial, name, nameVi });
  }

  const priorityRank = (iso: string) => {
    const i = PRIORITY_ISO.indexOf(iso);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  list.sort((a, b) => {
    const ra = priorityRank(a.iso);
    const rb = priorityRank(b.iso);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
  return list;
}

export const PHONE_COUNTRIES: readonly PhoneCountry[] = buildCountries();

const COUNTRY_BY_ISO = new Map(PHONE_COUNTRIES.map((c) => [c.iso, c]));

/** Fallback when the salon's timezone doesn't map to a supported country. */
export const DEFAULT_PHONE_ISO = "US";

// IANA timezone → ISO country, used to default the picker from salon location.
// Covers all major business regions worldwide; anything unmapped falls back to
// DEFAULT_PHONE_ISO, and the customer can still pick any country from the list.
const TIMEZONE_TO_ISO: Readonly<Record<string, string>> = {
  // ── North America ─────────────────────────────────────────
  "America/Los_Angeles": "US", "America/Denver": "US", "America/Phoenix": "US",
  "America/Chicago": "US", "America/New_York": "US", "America/Detroit": "US",
  "America/Anchorage": "US", "America/Adak": "US", "Pacific/Honolulu": "US",
  "America/Toronto": "CA", "America/Vancouver": "CA", "America/Edmonton": "CA",
  "America/Winnipeg": "CA", "America/Halifax": "CA", "America/St_Johns": "CA",
  "America/Regina": "CA", "America/Moncton": "CA",
  "America/Mexico_City": "MX", "America/Tijuana": "MX", "America/Monterrey": "MX",
  "America/Cancun": "MX", "America/Merida": "MX", "America/Chihuahua": "MX",
  // ── Central / South America ───────────────────────────────
  "America/Guatemala": "GT", "America/Costa_Rica": "CR", "America/Panama": "PA",
  "America/Bogota": "CO", "America/Lima": "PE", "America/Caracas": "VE",
  "America/Santiago": "CL", "America/Argentina/Buenos_Aires": "AR",
  "America/Sao_Paulo": "BR", "America/Montevideo": "UY", "America/La_Paz": "BO",
  "America/Asuncion": "PY", "America/Guayaquil": "EC",
  // ── Europe ────────────────────────────────────────────────
  "Europe/London": "GB", "Europe/Dublin": "IE", "Europe/Lisbon": "PT",
  "Europe/Madrid": "ES", "Europe/Paris": "FR", "Europe/Brussels": "BE",
  "Europe/Amsterdam": "NL", "Europe/Berlin": "DE", "Europe/Rome": "IT",
  "Europe/Zurich": "CH", "Europe/Vienna": "AT", "Europe/Prague": "CZ",
  "Europe/Warsaw": "PL", "Europe/Budapest": "HU", "Europe/Copenhagen": "DK",
  "Europe/Stockholm": "SE", "Europe/Oslo": "NO", "Europe/Helsinki": "FI",
  "Europe/Athens": "GR", "Europe/Bucharest": "RO", "Europe/Sofia": "BG",
  "Europe/Kyiv": "UA", "Europe/Kiev": "UA", "Europe/Moscow": "RU",
  "Europe/Istanbul": "TR", "Europe/Zagreb": "HR", "Europe/Belgrade": "RS",
  "Europe/Bratislava": "SK", "Europe/Ljubljana": "SI", "Europe/Vilnius": "LT",
  "Europe/Riga": "LV", "Europe/Tallinn": "EE", "Europe/Luxembourg": "LU",
  // ── Middle East ───────────────────────────────────────────
  "Asia/Dubai": "AE", "Asia/Riyadh": "SA", "Asia/Qatar": "QA", "Asia/Kuwait": "KW",
  "Asia/Bahrain": "BH", "Asia/Muscat": "OM", "Asia/Jerusalem": "IL",
  "Asia/Tel_Aviv": "IL", "Asia/Beirut": "LB", "Asia/Amman": "JO", "Asia/Baghdad": "IQ",
  // ── Asia ──────────────────────────────────────────────────
  "Asia/Singapore": "SG", "Asia/Kuala_Lumpur": "MY", "Asia/Bangkok": "TH",
  "Asia/Jakarta": "ID", "Asia/Manila": "PH", "Asia/Ho_Chi_Minh": "VN",
  "Asia/Saigon": "VN", "Asia/Hong_Kong": "HK", "Asia/Taipei": "TW",
  "Asia/Shanghai": "CN", "Asia/Tokyo": "JP", "Asia/Seoul": "KR",
  "Asia/Kolkata": "IN", "Asia/Calcutta": "IN", "Asia/Karachi": "PK",
  "Asia/Dhaka": "BD", "Asia/Colombo": "LK", "Asia/Kathmandu": "NP",
  "Asia/Yangon": "MM", "Asia/Phnom_Penh": "KH", "Asia/Vientiane": "LA",
  // ── Oceania ───────────────────────────────────────────────
  "Australia/Sydney": "AU", "Australia/Melbourne": "AU", "Australia/Brisbane": "AU",
  "Australia/Perth": "AU", "Australia/Adelaide": "AU", "Pacific/Auckland": "NZ",
  "Pacific/Fiji": "FJ", "Pacific/Guam": "GU",
  // ── Africa ────────────────────────────────────────────────
  "Africa/Johannesburg": "ZA", "Africa/Cairo": "EG", "Africa/Lagos": "NG",
  "Africa/Nairobi": "KE", "Africa/Casablanca": "MA", "Africa/Accra": "GH",
  "Africa/Tunis": "TN", "Africa/Algiers": "DZ", "Africa/Addis_Ababa": "ET",
};

export function countryByIso(iso: string): PhoneCountry | undefined {
  return COUNTRY_BY_ISO.get(iso.toUpperCase());
}

/** Resolve the default country for the picker from the salon's timezone.
 *  Always returns a valid country (falls back to US). */
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
