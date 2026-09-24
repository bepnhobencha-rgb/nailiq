/** Persisted service value only. This is not payment or settlement evidence. */
export function serviceValueCents(row: { price_cents: number | null; addon_price_cents?: number | null }): number {
  const main = row.price_cents != null && Number.isFinite(Number(row.price_cents)) ? Number(row.price_cents) : 0;
  const addon = row.addon_price_cents != null && Number.isFinite(Number(row.addon_price_cents)) ? Number(row.addon_price_cents) : 0;
  return main + addon;
}
