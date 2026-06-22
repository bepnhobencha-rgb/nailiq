import type { SupabaseClient } from "@supabase/supabase-js";

export type PromoResult = {
  /** Null when no active promo applies to this service. */
  promoId: string | null;
  promoName: string | null;
  /** Final price after discount. Same as basePriceCents when no promo. */
  finalPriceCents: number;
  /** Amount saved (0 when no promo). */
  discountCents: number;
};

/**
 * Resolve the best active promotion for a service at a given booking time.
 *
 * Priority: per-service rule > campaign-level rule.
 * When multiple campaigns match, the one with the largest discount wins.
 *
 * `bookingTimeLocal` — appointment wall-clock in the salon's local timezone
 * (YYYY-MM-DDTHH:mm). Used to match days_of_week + time_start/time_end.
 */
export async function resolvePromoPrice(
  supabase: SupabaseClient,
  salonId: string,
  serviceId: string,
  basePriceCents: number,
  bookingTimeUtc: Date,
  salonTimezone: string,
): Promise<PromoResult> {
  const noPromo: PromoResult = {
    promoId: null,
    promoName: null,
    finalPriceCents: basePriceCents,
    discountCents: 0,
  };

  // Only run if there's a real base price to discount
  if (!basePriceCents || basePriceCents <= 0) return noPromo;

  const now = bookingTimeUtc.toISOString();

  // Fetch active promotions for this salon at the booking time
  const { data: promos, error } = await supabase
    .from("promotions" as never)
    .select("id, name, discount_type, discount_value, applies_to, days_of_week, time_start, time_end")
    .eq("salon_id" as never, salonId)
    .eq("active" as never, true)
    .lte("starts_at" as never, now)
    .gte("ends_at" as never, now);

  if (error || !promos?.length) return noPromo;

  // Local time in salon timezone for day-of-week and time checks
  const localFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: salonTimezone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const localParts = localFormatter.formatToParts(bookingTimeUtc);
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const localWeekday = weekdayMap[localParts.find((p) => p.type === "weekday")?.value ?? ""] ?? -1;
  const localHour = parseInt(localParts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const localMin = parseInt(localParts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const localTimeMinutes = localHour * 60 + localMin;

  const promoIds = (promos as { id: string }[]).map((p) => p.id);

  // Fetch per-service rules for this service in one query
  const { data: svcRules } = await supabase
    .from("promotion_services" as never)
    .select("promotion_id, discount_type, discount_value")
    .in("promotion_id" as never, promoIds)
    .eq("service_id" as never, serviceId);

  const svcRuleMap = new Map<string, { discount_type: string; discount_value: number }>();
  for (const r of (svcRules ?? []) as { promotion_id: string; discount_type: string | null; discount_value: number | null }[]) {
    if (r.discount_type && r.discount_value != null) {
      svcRuleMap.set(r.promotion_id, { discount_type: r.discount_type, discount_value: r.discount_value });
    }
  }

  let bestPromoId: string | null = null;
  let bestPromoName: string | null = null;
  let bestDiscountCents = 0;

  for (const promo of promos as {
    id: string;
    name: string;
    discount_type: string;
    discount_value: number;
    applies_to: string;
    days_of_week: number[] | null;
    time_start: string | null;
    time_end: string | null;
  }[]) {
    // Check schedule constraints
    if (promo.days_of_week && promo.days_of_week.length > 0) {
      if (!promo.days_of_week.includes(localWeekday)) continue;
    }
    if (promo.time_start && promo.time_end) {
      const [sh, sm] = promo.time_start.split(":").map(Number);
      const [eh, em] = promo.time_end.split(":").map(Number);
      const startM = sh * 60 + sm;
      const endM = eh * 60 + em;
      if (localTimeMinutes < startM || localTimeMinutes >= endM) continue;
    }

    // Determine which discount rule to use
    let dtype: string;
    let dvalue: number;

    const svcRule = svcRuleMap.get(promo.id);
    if (svcRule) {
      dtype = svcRule.discount_type;
      dvalue = svcRule.discount_value;
    } else if (promo.applies_to === "all") {
      dtype = promo.discount_type;
      dvalue = promo.discount_value;
    } else {
      // 'specific' applies_to but no per-service row → skip this service
      continue;
    }

    const discountCents = calcDiscount(basePriceCents, dtype, dvalue);
    if (discountCents > bestDiscountCents) {
      bestDiscountCents = discountCents;
      bestPromoId = promo.id;
      bestPromoName = promo.name;
    }
  }

  if (!bestPromoId || bestDiscountCents <= 0) return noPromo;

  return {
    promoId: bestPromoId,
    promoName: bestPromoName,
    finalPriceCents: Math.max(0, basePriceCents - bestDiscountCents),
    discountCents: bestDiscountCents,
  };
}

function calcDiscount(baseCents: number, type: string, value: number): number {
  switch (type) {
    case "fixed_price":
      // value IS the final price in cents
      return Math.max(0, baseCents - value);
    case "amount":
      return Math.min(value, baseCents);
    case "percent":
      // value = basis points (2000 = 20%)
      return Math.round((baseCents * value) / 10000);
    default:
      return 0;
  }
}
