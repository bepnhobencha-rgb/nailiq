/** Shared client + server validation for salon setup address & phone. */

export const SETUP_COUNTRY_OPTIONS = [
  "Canada",
  "United States",
  "Vietnam",
  "Australia",
  "United Kingdom",
  "Other",
] as const;

export type SetupCountry = (typeof SETUP_COUNTRY_OPTIONS)[number];

const CA_POSTAL = /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i;
const US_ZIP = /^\d{5}(-\d{4})?$/;

export function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15;
}

/** Allow digits, spaces, + - ( ) only */
export function filterSalonPhoneInput(raw: string): string {
  return raw.replace(/[^\d\s+\-()]/g, "");
}

export function validateStreet(street: string): boolean {
  return street.trim().length >= 5;
}

export function validateCity(city: string): boolean {
  return city.trim().length >= 2;
}

export function validateProvince(province: string): boolean {
  return province.trim().length >= 2;
}

export function isValidPostalCode(postal: string): boolean {
  const t = postal.trim();
  if (t.length < 3) return false;
  if (CA_POSTAL.test(t) || US_ZIP.test(t)) return true;
  return t.length >= 3;
}

export function isAllowedCountry(country: string): country is SetupCountry {
  const c = country.trim();
  return (SETUP_COUNTRY_OPTIONS as readonly string[]).includes(c);
}

/** QA re-test #11 — normalize postal-code casing at write-time so
 * the DB stores a canonical form. Canadian A1A 1A1 is uppercased
 * regardless of how the owner typed it; US ZIP and other formats
 * pass through untouched. Display-side regex (BookingSalonInfoLine)
 * remains as a belt-and-braces for any legacy lowercase rows that
 * haven't been re-saved since this normalization landed. */
function normalizePostal(raw: string): string {
  const t = raw.trim();
  if (/^[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$/.test(t)) {
    // Canonical Canadian form: uppercase + single space.
    return t.replace(/\s+/g, "").toUpperCase().replace(
      /^([A-Z]\d[A-Z])(\d[A-Z]\d)$/,
      "$1 $2",
    );
  }
  return t;
}

export function buildSalonAddressString(parts: {
  street: string;
  city: string;
  province: string;
  postal: string;
  country: string;
}): string {
  const street = parts.street.trim();
  const city = parts.city.trim();
  const province = parts.province.trim();
  const postal = normalizePostal(parts.postal);
  const country = parts.country.trim();
  return `${street}, ${city}, ${province} ${postal}, ${country}`;
}

function splitProvincePostal(
  segment: string,
): { province: string; postal: string } {
  const t = segment.trim();
  const ca = t.match(/^(.+?)\s+([A-Z]\d[A-Z]\s?\d[A-Z]\d)$/i);
  if (ca) {
    return { province: ca[1].trim(), postal: ca[2].trim() };
  }
  const us = t.match(/^(.+?)\s+(\d{5}(?:-\d{4})?)$/);
  if (us) {
    return { province: us[1].trim(), postal: us[2].trim() };
  }
  const tokens = t.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    const postal = tokens[tokens.length - 1] ?? "";
    const province = tokens.slice(0, -1).join(" ");
    return { province, postal };
  }
  return { province: t, postal: "" };
}

/** Best-effort parse of DB `salons.address` into form fields. */
export function parseStoredAddress(raw: string): {
  street: string;
  city: string;
  province: string;
  postal: string;
  country: string;
} {
  const trimmed = raw.trim();
  const empty = {
    street: "",
    city: "",
    province: "",
    postal: "",
    country: "Canada",
  };
  if (!trimmed) return empty;

  const parts = trimmed.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 1) {
    return { ...empty, street: parts[0] ?? "" };
  }
  if (parts.length === 2) {
    return {
      ...empty,
      street: parts[0] ?? "",
      city: parts[1] ?? "",
    };
  }
  if (parts.length === 3) {
    const pp = splitProvincePostal(parts[2] ?? "");
    return {
      ...empty,
      street: parts[0] ?? "",
      city: parts[1] ?? "",
      province: pp.province,
      postal: pp.postal,
    };
  }

  const country = parts[parts.length - 1] ?? "";
  const mid = parts[parts.length - 2] ?? "";
  const city = parts[parts.length - 3] ?? "";
  const street = parts.slice(0, parts.length - 3).join(", ");
  const pp = splitProvincePostal(mid);

  const normCountry = (SETUP_COUNTRY_OPTIONS as readonly string[]).includes(
    country,
  )
    ? country
    : "Other";

  return {
    street,
    city,
    province: pp.province,
    postal: pp.postal,
    country: normCountry,
  };
}
