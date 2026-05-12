/**
 * Booking-surface price formatters. Thin wrappers around the shared
 * `currencyFormat` helper so every call site renders prices in the
 * salon's `currency_code` (CAD / USD / VND) instead of hardcoded USD.
 *
 * The legacy `formatGuestPriceUsd*` exports remain for backwards
 * compatibility with code paths that haven't been threaded a salon
 * currency yet — they delegate to the same helper with `"USD"`.
 * Prefer `formatBookingPrice` (currency-aware) in new code.
 */
import {
  formatCurrency,
  formatCurrencyOrZero,
  type Currency,
} from "@/shared/lib/currencyFormat";

/** Catalog-tile price display in the salon's currency.
 *  Returns `null` for null/NaN/negative input so the caller can hide
 *  the price chip cleanly instead of rendering "$NaN" or "$0.00". */
export function formatBookingPrice(
  priceCents: number | null,
  currency: Currency | string | null | undefined,
): string | null {
  return formatCurrency(priceCents, currency);
}

/** Receipt total — always renders, falls back to zero in the right
 *  currency on bad input. Used on the confirmation / success screens
 *  where blanks would be jarring. */
export function formatBookingPriceReceipt(
  priceCents: number,
  currency: Currency | string | null | undefined,
): string {
  return formatCurrencyOrZero(priceCents, currency);
}

/** Backwards-compatible USD-only helpers. Kept so existing call sites
 *  don't break before we've finished threading currency through every
 *  loader. Internally dispatches to the same Intl-based formatter. */
export function formatGuestPriceUsd(priceCents: number | null): string | null {
  return formatCurrency(priceCents, "USD");
}

/** @deprecated Use `formatBookingPriceReceipt(cents, currency)`. */
export function formatGuestPriceUsdReceipt(priceCents: number): string {
  return formatCurrencyOrZero(priceCents, "USD");
}
