import { NextResponse } from "next/server";

import { inspectBookingManagementCapability } from "@/shared/booking/bookingManagementCapabilities";
import { consumeBookingManagementRateLimit } from "@/shared/booking/bookingManagementRateLimit";
import { inspectCardRecovery } from "@/shared/booking/bookingCardRecovery";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache",
  "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow",
} as const;
const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
const CARD_BRANDS = new Set(["VISA", "MASTERCARD", "AMERICAN_EXPRESS", "AMEX", "DISCOVER", "DISCOVER_DINERS",
  "DINERS", "DINERS_CLUB", "JCB", "CHINA_UNIONPAY", "UNIONPAY", "UNION_PAY", "INTERAC", "EFTPOS", "FELICA", "OTHER_BRAND"]);
const providerId = (value: string | null) => /^[A-Za-z0-9:_-]{1,255}$/.test(value ?? "");

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token")?.trim() ?? "";
  if (!token) return json({ ok: false, code: "invalid_request" }, 400);
  const rate = await consumeBookingManagementRateLimit({ request: req, tokenId: token, action: "card_manage", phase: "inspect" });
  if (rate !== "allowed") return json({ ok: false, code: rate === "limited" ? "rate_limited" : "management_unavailable" }, rate === "limited" ? 429 : 503);
  const inspected = await inspectBookingManagementCapability({ tokenId: token, expectedAction: "card_manage" });
  if (!inspected.ok) return json({ ok: false, code: inspected.code }, inspected.code === "management_unavailable" ? 503 : 404);

  const { bookingId, salonId } = inspected.inspection.context;
  const db = createServiceRoleClient();
  const [bookingResult, salonResult, recovery] = await Promise.all([
    db.from("bookings" as never).select("noshow_card_id,noshow_customer_id,noshow_card_last4,noshow_card_brand,noshow_fee_cents,noshow_charge_status,card_protection_status").eq("id", bookingId).eq("salon_id", salonId).maybeSingle(),
    db.from("salons" as never).select("name,currency_code,brand_color,theme_mode").eq("id", salonId).maybeSingle(),
    inspectCardRecovery(token),
  ]);
  if (bookingResult.error || salonResult.error || !bookingResult.data || !salonResult.data) {
    return json({ ok: false, code: "management_unavailable" }, 503);
  }
  if (!recovery.ok) return json({ ok: false, code: recovery.code }, recovery.code === "management_unavailable" ? 503 : 404);
  if (recovery.context.bookingId !== bookingId || recovery.context.salonId !== salonId) {
    return json({ ok: false, code: "management_unavailable" }, 503);
  }
  const booking = bookingResult.data as {
    noshow_card_id: string | null; noshow_customer_id: string | null; noshow_card_last4: string | null; noshow_card_brand: string | null;
    noshow_fee_cents: number | null; noshow_charge_status: string | null; card_protection_status: string | null;
  };
  const salon = salonResult.data as { name: string | null; currency_code: string | null; brand_color: string | null; theme_mode: string | null };
  const currency = String(salon.currency_code || "USD").trim().toUpperCase() || "USD";
  const card = inspected.inspection.cardManage;
  const brand = CARD_BRANDS.has(card.cardBrand ?? "") ? card.cardBrand! : "";
  const last4 = /^[0-9]{4}$/.test(card.cardLast4 ?? "") ? card.cardLast4! : "";
  // A physical card remains removable even if its delivery/consent is unproven.
  // Only the durable receipt projection may activate protection or fee copy.
  const protectionActive = recovery.context.protectionStatus === "saved" && booking.card_protection_status === "saved" &&
    card.hasCard && providerId(booking.noshow_card_id) && providerId(booking.noshow_customer_id) &&
    !!brand && !!last4 && brand === booking.noshow_card_brand && last4 === booking.noshow_card_last4;
  const protectionStatus = recovery.context.protectionStatus === "saved" && !protectionActive
    ? "manual_review" : recovery.context.protectionStatus;
  return json({
    ok: true, salonName: salon.name ?? "", hasCard: card.hasCard,
    protectionStatus, protectionActive,
    brandColor: /^#[0-9a-f]{6}$/i.test(salon.brand_color ?? "") ? salon.brand_color : "#D4AF37",
    themeMode: salon.theme_mode === "light" ? "light" : "dark",
    brand, last4,
    cardFingerprint: card.cardFingerprint,
    feeLabel: protectionActive ? `${((booking.noshow_fee_cents ?? 0) / 100).toFixed(2)} ${currency}` : "",
    status: card.chargeStatus ?? "",
  });
}
