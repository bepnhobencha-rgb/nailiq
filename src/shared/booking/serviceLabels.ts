// Shared label builders for services & add-ons. ONE source of truth so every
// surface (online single + group booking, desk create/edit/group) renders the
// same chip/option text and can never drift again.
//
// History: the add-on chip text was hand-built in ~5 places and drifted into 4
// different formats — online group "Name · +20′ · $20", desk edit "Name · 20m
// · $20", desk single "Name · $20" (no minutes), desk group "Name" (no minutes
// or price). Centralised here.

import type { BookingServiceItem } from "@/shared/booking/catalog";

type AddonLike = Pick<
  BookingServiceItem,
  "name" | "addonConcurrent" | "durationMinutes" | "priceDisplay"
>;

/**
 * Timing + price suffix for an add-on, e.g. " · +20′ · $20.00".
 * Concurrent add-ons (run during the main service, add no chair time) show
 * " · ✨ +0′"; sequential ones show " · +N′". Mirrors the original online
 * group-flow convention so all surfaces match byte-for-byte.
 */
export function addonMetaSuffix(a: AddonLike): string {
  const timing = a.addonConcurrent
    ? " · ✨ +0′"
    : a.durationMinutes > 0
      ? ` · +${a.durationMinutes}′`
      : "";
  const price = a.priceDisplay ? ` · ${a.priceDisplay}` : "";
  return `${timing}${price}`;
}

/** Full add-on label: "Hot Oil Treatment · +20′ · $20.00". */
export function addonLabel(a: AddonLike): string {
  return `${a.name}${addonMetaSuffix(a)}`;
}
