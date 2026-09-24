import { salonDateOffset } from "@/shared/lib/salonTime";
import type { PulseAttentionKind } from "./loadOwnerPulse";

/** Match the destination date to the salon-local day of the displayed snapshot. */
export function ownerPulseAttentionHref(input: {
  slug: string; kind: PulseAttentionKind; timezone: string; generatedAtUtc: string;
}): string {
  const base = `/dashboard/${encodeURIComponent(input.slug)}/center`;
  if (input.kind === "waitlist") return `${base}?view=day#waitlist`;
  if (input.kind === "tomorrow_low") {
    return `${base}?view=day&date=${salonDateOffset(input.timezone, 1, input.generatedAtUtc)}`;
  }
  return base;
}
