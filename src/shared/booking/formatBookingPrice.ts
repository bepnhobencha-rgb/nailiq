/** Always two decimals so catalog tiles, review summary, and receipts agree ($45 → $45.00). */
const PRICE_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** US-style display for catalog prices on the guest booking flow. */
export function formatGuestPriceUsd(priceCents: number | null): string | null {
  if (priceCents == null || !Number.isFinite(priceCents)) return null;
  const n = Math.round(Number(priceCents));
  if (n < 0) return null;
  return PRICE_FORMATTER.format(n / 100);
}

/** Receipt-style total on booking success (always two decimals). */
export function formatGuestPriceUsdReceipt(priceCents: number): string {
  const n = Math.round(Number(priceCents));
  if (!Number.isFinite(n) || n < 0) return "$0.00";
  return PRICE_FORMATTER.format(n / 100);
}
