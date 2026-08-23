import { NextResponse } from "next/server";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { consumePublicRequestRateLimit } from "@/shared/security/publicServerActionRateLimit";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ClaimedOfferPayload = {
  available: true;
  service_id: string;
  service_name: string;
  price_cents: number;
  price_type: "fixed" | "from" | "range";
  price_max_cents: number | null;
  added_duration_minutes: number;
  reason: string;
  confidence: number;
  session_id: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function claimedOfferPayload(
  value: unknown,
  sessionId: string,
  suggestedServiceId: string,
): ClaimedOfferPayload | null {
  const payload = record(value);
  if (!payload) return null;
  const priceCents = payload.price_cents;
  const priceMaxCents = payload.price_max_cents;
  const addedDuration = payload.added_duration_minutes;
  const confidence = payload.confidence;
  if (
    payload.available !== true
    || payload.service_id !== suggestedServiceId
    || payload.session_id !== sessionId
    || typeof payload.service_name !== "string"
    || payload.service_name.length < 1
    || payload.service_name.length > 255
    || !Number.isSafeInteger(priceCents)
    || (priceCents as number) < 0
    || !new Set(["fixed", "from", "range"]).has(String(payload.price_type))
    || (priceMaxCents !== null
      && (!Number.isSafeInteger(priceMaxCents) || (priceMaxCents as number) < 0))
    || !Number.isSafeInteger(addedDuration)
    || (addedDuration as number) < 0
    || typeof payload.reason !== "string"
    || payload.reason.length < 1
    || payload.reason.length > 500
    || typeof confidence !== "number"
    || !Number.isFinite(confidence)
    || confidence < 0
    || confidence > 1
  ) return null;
  return {
    available: true,
    service_id: payload.service_id as string,
    service_name: payload.service_name as string,
    price_cents: priceCents as number,
    price_type: payload.price_type as ClaimedOfferPayload["price_type"],
    price_max_cents: priceMaxCents as number | null,
    added_duration_minutes: addedDuration as number,
    reason: payload.reason as string,
    confidence,
    session_id: payload.session_id as string,
  };
}

function response(
  body: Record<string, unknown>,
  status = 200,
) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/**
 * GET /api/upsell?salon_id=X&phone=Y&selected_service_id=Z&session_id=S&otp_session_id=O
 *
 * Returns an upsell suggestion if:
 * - The salon is Pro+ tier
 * - Customer has history (≥3 bookings) showing an add-on ≥40% of the time
 * - The suggested add-on is NOT already selected
 * - The customer hasn't dismissed 3+ times recently
 */
export async function GET(req: Request) {
  const ipRate = await consumePublicRequestRateLimit({
    request: req,
    scope: "customer-upsell",
    ipLimits: [[30, 60], [120, 3_600]],
  });
  if (ipRate !== "allowed") {
    return response(
      { available: false, error: ipRate === "limited" ? "rate_limited" : "temporarily_unavailable" },
      ipRate === "limited" ? 429 : 503,
    );
  }

  const { searchParams } = new URL(req.url);
  const salonIdInput = (searchParams.get("salon_id") ?? "").trim();
  const phone = (searchParams.get("phone") ?? "").trim();
  const selectedServiceIdInput = (searchParams.get("selected_service_id") ?? "").trim();
  const otpSessionIdInput = (searchParams.get("otp_session_id") ?? "").trim();
  const sessionIdInput = (searchParams.get("session_id") ?? "").trim();
  const phoneResult = validateGuestPhone(phone);

  if (
    !UUID_RE.test(salonIdInput) || !UUID_RE.test(selectedServiceIdInput) ||
    !UUID_RE.test(otpSessionIdInput) || !UUID_RE.test(sessionIdInput) || !phoneResult.ok
  ) {
    return response({ available: false, error: "invalid_request" }, 400);
  }
  // PostgreSQL serializes UUIDs canonically in lower case. Normalize browser
  // input before hashing/comparing replay payloads so case cannot poison a
  // durable claim that the route would subsequently reject.
  const salonId = salonIdInput.toLowerCase();
  const selectedServiceId = selectedServiceIdInput.toLowerCase();
  const otpSessionId = otpSessionIdInput.toLowerCase();
  const sessionId = sessionIdInput.toLowerCase();
  const phoneDigits = phoneResult.digits;

  const identityRate = await consumePublicRequestRateLimit({
    request: req,
    scope: "customer-upsell-identity",
    identity: [salonId, phoneDigits, otpSessionId],
    ipLimits: [],
    identityLimits: [[10, 900], [30, 86_400]],
  });
  if (identityRate !== "allowed") {
    return response(
      { available: false, error: identityRate === "limited" ? "rate_limited" : "temporarily_unavailable" },
      identityRate === "limited" ? 429 : 503,
    );
  }

  const db = createServiceRoleClient();

  // History personalization is customer-specific. Caller-supplied salon/phone
  // material is never sufficient: require the exact active OTP capability
  // before any salon, booking, service or upsell-log access.
  const { data: otpValid, error: otpError } = await db.rpc(
    "validate_phone_otp_session",
    { p_session_id: otpSessionId, p_salon_id: salonId, p_phone: phoneDigits },
  );
  if (otpError) return response({ available: false, error: "temporarily_unavailable" }, 503);
  if (otpValid !== true) return response({ available: false, error: "not_authorized" }, 401);

  // Check salon tier
  const { data: salon } = await db
    .from("salons")
    .select("subscription_plan, plan_override, feature_flags")
    .eq("id", salonId)
    .single();

  if (!salon) return response({ available: false });

  const plan = (salon.plan_override ?? salon.subscription_plan) as string;
  const flags = salon.feature_flags as Record<string, boolean> | null;
  const featureEnabled =
    flags?.["ai_smart_upsell"] !== undefined
      ? flags["ai_smart_upsell"]
      : ["pro", "premium", "enterprise"].includes(plan);

  if (!featureEnabled) return response({ available: false });

  // Get last 10 bookings for this customer+salon
  const { data: bookings } = await db
    .from("bookings")
    .select("service_id, addon_service_id, client_locale")
    .eq("salon_id", salonId)
    .eq("client_phone", phoneDigits)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(10);

  if (!bookings || bookings.length < 3) return response({ available: false });

  // Count how often each add-on service appears
  const addonCounts: Record<string, number> = {};
  for (const b of bookings) {
    if (b.addon_service_id && b.addon_service_id !== selectedServiceId) {
      addonCounts[b.addon_service_id] = (addonCounts[b.addon_service_id] ?? 0) + 1;
    }
  }

  // Find add-on appearing ≥40% of the time
  const threshold = bookings.length * 0.4;
  const topAddon = Object.entries(addonCounts)
    .filter(([, count]) => count >= threshold)
    .sort(([, a], [, b]) => b - a)[0];

  if (!topAddon) return response({ available: false });

  const [addonServiceId] = topAddon;

  // Fetch service details
  const { data: service } = await db
    .from("services")
    .select("id, name, price_cents, price_type, price_max_cents, duration_minutes, buffer_minutes, is_addon, addon_timing")
    .eq("id", addonServiceId)
    .eq("salon_id", salonId)
    .eq("is_addon", true)
    .is("deleted_at", null)
    .single();

  if (!service) return response({ available: false });

  // Claim the suggestion atomically. The DB re-validates the exact OTP
  // capability and current salon/service material, writes one durable shown
  // row, and returns the same bounded payload on an exact concurrent replay.
  const frequency = Math.round((topAddon[1] / bookings.length) * 100);
  // Language for the copy — NOT the plan tier (the old `plan === "vi"` compared
  // the subscription plan against a locale code, so it was always false and VN
  // customers always got English). Prefer an explicit ?lang, else the customer's
  // stored locale from their most recent booking, else English.
  const langParam = (searchParams.get("lang") ?? "").toLowerCase();
  const storedLocale = String(
    (bookings[0] as { client_locale?: string | null } | undefined)?.client_locale ?? "",
  ).toLowerCase();
  const isVi = langParam.startsWith("vi") || storedLocale.startsWith("vi");
  const reason = isVi
    ? `Bạn thường thêm dịch vụ này (${frequency}% lần ghé thăm)`
    : `You usually add this (${frequency}% of your visits)`;

  const { data: claimData, error: claimError } = await db.rpc(
    "claim_ai_upsell_offer" as never,
    {
      p_salon_id: salonId,
      p_session_id: sessionId,
      p_otp_session_id: otpSessionId,
      p_client_phone: phoneDigits,
      p_selected_service_id: selectedServiceId,
      p_suggested_service_id: addonServiceId,
      p_suggestion_reason: reason,
      p_confidence_score: topAddon[1] / bookings.length,
    } as never,
  );
  if (claimError) {
    return response({ available: false, error: "temporarily_unavailable" }, 503);
  }
  const claim = record(Array.isArray(claimData) ? claimData[0] : claimData);
  const claimOutcome = claim?.outcome;
  if (claimOutcome === "invalid_capability") {
    return response({ available: false, error: "not_authorized" }, 401);
  }
  if (claimOutcome !== "claimed" && claimOutcome !== "replayed") {
    return response({ available: false, error: "offer_conflict" }, 409);
  }
  if (
    typeof claim?.claim_id !== "string"
    || !UUID_RE.test(claim.claim_id)
    || typeof claim.upsell_log_id !== "string"
    || !UUID_RE.test(claim.upsell_log_id)
    || claim.replay !== (claimOutcome === "replayed")
  ) {
    return response({ available: false, error: "temporarily_unavailable" }, 503);
  }
  const payload = claimedOfferPayload(
    claim.offer_payload,
    sessionId,
    addonServiceId,
  );
  if (!payload) {
    return response({ available: false, error: "temporarily_unavailable" }, 503);
  }
  return response(payload);
}
