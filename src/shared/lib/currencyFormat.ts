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

export const SUPPORTED_CURRENCIES = ["CAD", "USD", "VND"] as const;
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
  CAD: "en-CA",
  USD: "en-US",
  VND: "vi-VN",
};

/** Whether the currency uses fractional units (cents, pence, …). VND
 *  is whole-đồng only — `Intl` handles this automatically when we set
 *  the right `minimumFractionDigits`. */
const FRACTION_DIGITS: Record<Currency, number> = {
  CAD: 2,
  USD: 2,
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
