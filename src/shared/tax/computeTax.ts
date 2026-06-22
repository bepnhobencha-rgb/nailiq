import type { TaxLine } from "@/shared/tax/taxTypes";

export type TaxBreakdownItem = {
  name: string;
  rate: number;
  amountCents: number;
};

export type TaxResult = {
  subtotalCents: number;
  taxAmountCents: number;
  totalCents: number;
  breakdown: TaxBreakdownItem[];
};

/** Compute tax from a subtotal and a list of tax lines.
 *  Disabled lines and zero-rate lines are skipped.
 *  Each line is computed independently on the subtotal (parallel, not compounded). */
export function computeTax(subtotalCents: number, taxLines: TaxLine[]): TaxResult {
  const active = taxLines.filter((l) => l.enabled && l.rate > 0);
  const breakdown: TaxBreakdownItem[] = active.map((l) => ({
    name: l.name,
    rate: l.rate,
    amountCents: Math.round(subtotalCents * l.rate),
  }));
  const taxAmountCents = breakdown.reduce((s, b) => s + b.amountCents, 0);
  return {
    subtotalCents,
    taxAmountCents,
    totalCents: subtotalCents + taxAmountCents,
    breakdown,
  };
}

export function hasTax(taxLines: TaxLine[] | null | undefined): boolean {
  return (taxLines ?? []).some((l) => l.enabled && l.rate > 0);
}
