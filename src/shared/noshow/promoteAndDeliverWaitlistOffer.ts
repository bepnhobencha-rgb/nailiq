import "server-only";

import { isBookingManagementToken } from "@/shared/booking/bookingManagementCapabilities";
import {
  deliverPromotedWaitlistOffer,
  type PromotedWaitlistOffer,
} from "@/shared/noshow/deliverPromotedWaitlistOffer";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

type CanonicalPromotion = {
  salonId: string;
  offer: PromotedWaitlistOffer;
};

type PromotionResult =
  | { ok: true; code: "promoted"; salonId: string; offer: PromotedWaitlistOffer }
  | { ok: true; code: "no_waiter" }
  | { ok: false; code: string };

function record(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : null;
}

function safeCode(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value)
    ? value
    : "waitlist_unavailable";
}

function parsePromotion(value: unknown): PromotionResult {
  const row = record(value);
  if (!row || row.ok !== true) return { ok: false, code: safeCode(row?.code) };
  if (row.code === "no_waiter") return { ok: true, code: "no_waiter" };
  if (row.code !== "promoted") return { ok: false, code: "invalid_waitlist_response" };
  const salonId = typeof row.salon_id === "string" ? row.salon_id.trim() : "";
  const waitlistEntryId = typeof row.waitlist_entry_id === "string"
    ? row.waitlist_entry_id.trim()
    : "";
  const claimCapabilityToken = typeof row.claim_capability_token === "string"
    ? row.claim_capability_token.trim()
    : "";
  const offerEpoch = row.offer_epoch;
  if (!isBookingManagementToken(salonId) || !isBookingManagementToken(waitlistEntryId) ||
      !isBookingManagementToken(claimCapabilityToken) ||
      !Number.isSafeInteger(offerEpoch) || (offerEpoch as number) < 1) {
    return { ok: false, code: "invalid_waitlist_response" };
  }
  return {
    ok: true,
    code: "promoted",
    salonId,
    offer: { waitlistEntryId, claimCapabilityToken, offerEpoch: offerEpoch as number },
  };
}

async function deliverExactPromotion(promotion: CanonicalPromotion): Promise<void> {
  await deliverPromotedWaitlistOffer({ salonId: promotion.salonId, offer: promotion.offer });
}

/** Strictly validate and deliver an exact promotion embedded in another DB mutation result. */
export async function deliverCanonicalWaitlistPromotion(value: unknown): Promise<PromotionResult> {
  const parsed = parsePromotion(value);
  if (parsed.ok && parsed.code === "promoted") await deliverExactPromotion(parsed);
  return parsed;
}

/** Canonical, replay-safe promotion for one booking whose slot was freed. */
export async function promoteAndDeliverWaitlistForBooking(
  bookingId: string,
): Promise<PromotionResult> {
  if (!isBookingManagementToken(bookingId)) return { ok: false, code: "invalid_request" };
  const { data, error } = await createServiceRoleClient().rpc(
    "promote_waitlist_for_booking" as never,
    { p_booking_id: bookingId } as never,
  );
  if (error) return { ok: false, code: "waitlist_unavailable" };
  const parsed = parsePromotion(data);
  if (parsed.ok && parsed.code === "promoted") await deliverExactPromotion(parsed);
  return parsed;
}

/** Authorized desk promotion for one selected waiting entry. */
export async function promoteAndDeliverSpecificWaitlistEntry(input: {
  salonId: string;
  waitlistEntryId: string;
  windowMinutes?: number;
}): Promise<PromotionResult> {
  const windowMinutes = input.windowMinutes ?? 20;
  if (!isBookingManagementToken(input.salonId) ||
      !isBookingManagementToken(input.waitlistEntryId) ||
      !Number.isSafeInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 120) {
    return { ok: false, code: "invalid_request" };
  }
  const { data, error } = await createServiceRoleClient().rpc(
    "promote_waitlist_entry" as never,
    {
      p_salon_id: input.salonId,
      p_waitlist_entry_id: input.waitlistEntryId,
      p_window_minutes: windowMinutes,
    } as never,
  );
  if (error) return { ok: false, code: "waitlist_unavailable" };
  return deliverCanonicalWaitlistPromotion(data);
}

/** Expire stale offers, then deliver only the exact capabilities returned by DB. */
export async function advanceAndDeliverWaitlistOffers(
  windowMinutes = 20,
): Promise<{ ok: true; advanced: number } | { ok: false; code: string }> {
  if (!Number.isSafeInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 120) {
    return { ok: false, code: "invalid_request" };
  }
  const { data, error } = await createServiceRoleClient().rpc(
    "advance_waitlist_offer_capabilities" as never,
    { p_window_minutes: windowMinutes } as never,
  );
  if (error) return { ok: false, code: "waitlist_unavailable" };
  if (!Array.isArray(data)) return { ok: false, code: "invalid_waitlist_response" };
  const promotions = data.map(parsePromotion);
  const invalid = promotions.find((result) => !result.ok || result.code !== "promoted");
  if (invalid) return { ok: false, code: invalid.code };
  for (const promotion of promotions) {
    if (promotion.ok && promotion.code === "promoted") await deliverExactPromotion(promotion);
  }
  return { ok: true, advanced: promotions.length };
}
