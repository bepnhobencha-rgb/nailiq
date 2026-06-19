/**
 * Single source of truth for rendering money on every NailIQ surface.
 *
 * The salon row carries `currency_code` (one of `CAD | USD | VND` —
 * migration 20260512000000). Every formatter accepts that code and
 * uses `Intl.NumberFormat` with a locale that matches the currency's
 * canonical home market, so:
 *
 *   - CAD shows as `CA$45.00` in en-CA locale
 *   - USD shows as `$45.00` in en-US locale
 *   - VND shows as `45.000 ₫` in vi-VN locale (no minor units)
 *
 * Stored prices remain integer cents (the smallest unit of the
 * salon's currency, e.g. 1 cent CAD / 1 VND đồng). NailIQ never
 * converts cross-currency — owner enters $45 in their currency and
 * we read it back in the same currency.
 */

export const SUPPORTED_CURRENCIES = [
  // North America
  "USD", "CAD", "MXN",
  // Europe
  "EUR", "GBP", "CHF",
  // Asia-Pacific / Middle East
  "AUD", "NZD", "SGD", "HKD", "JPY", "AED",
  // Vietnam (diaspora salons)
  "VND",
] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];
export const DEFAULT_CURRENCY: Currency = "CAD";

export function isSupportedCurrency(value: unknown): value is Currency {
  return (
    typeof value === "string" &&
    (SUPPORTED_CURRENCIES as readonly string[]).includes(value)
  );
}

export function parseCurrency(value: unknown): Currency {
  return isSupportedCurrency(value) ? value : DEFAULT_CURRENCY;
}

/** Locale used to render each currency. Picked to match the salon's
 *  home market so the symbol placement and decimal mark feel native. */
const LOCALE_BY_CURRENCY: Record<Currency, string> = {
  USD: "en-US",
  CAD: "en-CA",
  MXN: "es-MX",
  EUR: "en-IE",
  GBP: "en-GB",
  CHF: "de-CH",
  AUD: "en-AU",
  NZD: "en-NZ",
  SGD: "en-SG",
  HKD: "en-HK",
  JPY: "ja-JP",
  AED: "en-AE",
  VND: "vi-VN",
};

/** Whether the currency uses fractional units (cents, pence, …). VND
 *  is whole-đồng only — `Intl` handles this automatically when we set
 *  the right `minimumFractionDigits`. */
const FRACTION_DIGITS: Record<Currency, number> = {
  USD: 2,
  CAD: 2,
  MXN: 2,
  EUR: 2,
  GBP: 2,
  CHF: 2,
  AUD: 2,
  NZD: 2,
  SGD: 2,
  HKD: 2,
  JPY: 0,
  AED: 2,
  VND: 0,
};

const FORMATTER_CACHE = new Map<Currency, Intl.NumberFormat>();
function getFormatter(currency: Currency): Intl.NumberFormat {
  const cached = FORMATTER_CACHE.get(currency);
  if (cached) return cached;
  const formatter = new Intl.NumberFormat(LOCALE_BY_CURRENCY[currency], {
    style: "currency",
    currency,
    minimumFractionDigits: FRACTION_DIGITS[currency],
    maximumFractionDigits: FRACTION_DIGITS[currency],
  });
  FORMATTER_CACHE.set(currency, formatter);
  return formatter;
}

/** Convert an integer-cents value to a human-readable display string
 *  in the salon's currency. Returns `null` when the input is null,
 *  undefined, NaN, or negative — caller decides whether to render
 *  "—", an empty string, or hide the line entirely. */
export function formatCurrency(
  cents: number | null | undefined,
  currency: Currency | string | null | undefined,
): string | null {
  if (cents == null || !Number.isFinite(Number(cents))) return null;
  const n = Math.round(Number(cents));
  if (n < 0) return null;
  const safeCurrency = parseCurrency(currency);
  const major = n / Math.pow(10, FRACTION_DIGITS[safeCurrency] === 0 ? 0 : 2);
  // VND: cents and major are the same value (no minor units); /1.
  // CAD/USD: cents → dollars via /100.
  return getFormatter(safeCurrency).format(major);
}

/** Always-renders variant — used in totals/receipts where we want
 *  "0.00" rather than "—" for a zero amount. */
export function formatCurrencyOrZero(
  cents: number | null | undefined,
  currency: Currency | string | null | undefined,
): string {
  const formatted = formatCurrency(cents ?? 0, currency);
  if (formatted !== null) return formatted;
  // Fallback for malformed input — render zero in the resolved currency.
  return getFormatter(parseCurrency(currency)).format(0);
}

export type ServicePriceType = "fixed" | "from" | "range";

/**
 * Render a SERVICE price honouring its pricing model:
 *   fixed → "$47"
 *   from  → "From $35"  (priceCents is the minimum; `fromLabel` is localized)
 *   range → "$35–$60"   (priceCents = min, priceMaxCents = max)
 *
 * Falls back to the plain fixed format when a from/range is missing the data
 * it needs (e.g. range with no/!> max). Returns null when the base price is
 * null — caller decides whether to render "—".
 */
export function formatServicePrice(
  priceCents: number | null | undefined,
  currency: Currency | string | null | undefined,
  opts?: {
    priceType?: ServicePriceType | string | null;
    priceMaxCents?: number | null;
    fromLabel?: string; // localized "From" / "Từ"; defaults to "From"
  },
): string | null {
  const base = formatCurrency(priceCents, currency);
  if (base === null) return null;
  const type = opts?.priceType ?? "fixed";
  if (type === "range") {
    const max = formatCurrency(opts?.priceMaxCents, currency);
    if (max != null && Number(opts?.priceMaxCents) > Number(priceCents ?? 0)) {
      return `${base}–${max}`; // en-dash
    }
    return base;
  }
  if (type === "from") {
    return `${opts?.fromLabel ?? "From"} ${base}`;
  }
  return base;
}

/** Just the symbol, no value. Used by form labels like `Price (CA$)`.
 *  Pulled from the formatter so locale variants stay consistent. */
export function currencySymbol(
  currency: Currency | string | null | undefined,
): string {
  const safeCurrency = parseCurrency(currency);
  const parts = getFormatter(safeCurrency).formatToParts(0);
  const symbolPart = parts.find((p) => p.type === "currency");
  return symbolPart?.value ?? safeCurrency;
}
