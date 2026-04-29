/** US-style display for catalog prices on the guest booking flow (matches owner setup defaults). */
export function formatGuestPriceUsd(priceCents: number | null): string | null {
  if (priceCents == null || !Number.isFinite(priceCents)) return null;
  const n = Math.round(Number(priceCents));
  if (n < 0) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n / 100);
}

/** Receipt-style total on booking success (always two decimals). */
export function formatGuestPriceUsdReceipt(priceCents: number): string {
  const n = Math.round(Number(priceCents));
  if (!Number.isFinite(n) || n < 0) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n / 100);
}
