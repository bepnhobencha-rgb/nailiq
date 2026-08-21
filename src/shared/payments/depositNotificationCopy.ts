import {
  formatCurrencyOrZero,
  isSupportedCurrency,
  type Currency,
} from "@/shared/lib/currencyFormat";

/** Render the DB-owned smallest-unit amount without assuming dollar cents. */
export function formatDepositNotificationAmount(
  amountCents: number,
  currency: string,
): string | null {
  const normalized = currency.trim().toUpperCase();
  if (!Number.isSafeInteger(amountCents) || amountCents < 0 || !isSupportedCurrency(normalized)) {
    return null;
  }
  return formatCurrencyOrZero(amountCents, normalized as Currency);
}
