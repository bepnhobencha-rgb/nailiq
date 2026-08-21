/**
 * Despite the historical `*_cents` column name, NailIQ stores the provider's
 * smallest currency unit. For CAD this is cents; for VND/JPY/KRW it is the
 * whole unit. Provider dispatch is therefore identity-preserving.
 */
export function toProviderMinorAmount(
  internalCents: number,
  currency: string,
): number {
  if (!Number.isSafeInteger(internalCents) || internalCents <= 0) {
    throw new Error("invalid_internal_amount");
  }
  const normalized = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error("invalid_currency");
  }
  return internalCents;
}
