type PriceValue = number | null;

function normalizePrice(value: unknown): PriceValue {
  if (value === null) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : null;
}

/**
 * A time/staff/resource edit must preserve the price the customer actually
 * confirmed. Catalog prices are used only when the corresponding service
 * identity changes. This prevents an unchanged $23 discounted booking from
 * silently becoming the current $25 list price during reschedule.
 */
export function resolveDeskEditPrice(args: {
  identityChanged: boolean;
  persistedPrice: unknown;
  catalogPrice: unknown;
}): PriceValue {
  return normalizePrice(
    args.identityChanged ? args.catalogPrice : args.persistedPrice,
  );
}
