import { NextResponse } from "next/server";

import { inspectBookingManagementCapability } from "@/shared/booking/bookingManagementCapabilities";
import { consumeBookingManagementRateLimit } from "@/shared/booking/bookingManagementRateLimit";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache",
  "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow",
} as const;
const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: PRIVATE_HEADERS });

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token")?.trim() ?? "";
  if (!token) return json({ ok: false, code: "invalid_request" }, 400);
  const rate = await consumeBookingManagementRateLimit({ request: req, tokenId: token, action: "card_manage", phase: "inspect" });
  if (rate !== "allowed") return json({ ok: false, code: rate === "limited" ? "rate_limited" : "management_unavailable" }, rate === "limited" ? 429 : 503);
  const inspected = await inspectBookingManagementCapability({ tokenId: token, expectedAction: "card_manage" });
  if (!inspected.ok) return json({ ok: false, code: inspected.code }, inspected.code === "management_unavailable" ? 503 : 404);

  const { bookingId, salonId } = inspected.inspection.context;
  const db = createServiceRoleClient();
  const [bookingResult, salonResult] = await Promise.all([
    db.from("bookings" as never).select("noshow_card_id,noshow_card_last4,noshow_card_brand,noshow_fee_cents,noshow_charge_status").eq("id", bookingId).eq("salon_id", salonId).maybeSingle(),
    db.from("salons" as never).select("name,currency_code").eq("id", salonId).maybeSingle(),
  ]);
  if (bookingResult.error || salonResult.error || !bookingResult.data || !salonResult.data) {
    return json({ ok: false, code: "management_unavailable" }, 503);
  }
  const booking = bookingResult.data as {
    noshow_card_id: string | null; noshow_card_last4: string | null; noshow_card_brand: string | null;
    noshow_fee_cents: number | null; noshow_charge_status: string | null;
  };
  const salon = salonResult.data as { name: string | null; currency_code: string | null };
  const currency = String(salon.currency_code || "USD").trim().toUpperCase() || "USD";
  return json({
    ok: true, salonName: salon.name ?? "", hasCard: inspected.inspection.cardManage.hasCard,
    brand: inspected.inspection.cardManage.cardBrand ?? "",
    last4: inspected.inspection.cardManage.cardLast4 ?? "",
    cardFingerprint: inspected.inspection.cardManage.cardFingerprint,
    feeLabel: `${((booking.noshow_fee_cents ?? 0) / 100).toFixed(2)} ${currency}`,
    status: inspected.inspection.cardManage.chargeStatus ?? "",
  });
}
