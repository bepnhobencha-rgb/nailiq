import { NextResponse } from "next/server";

import { inspectBookingManagementCapability } from "@/shared/booking/bookingManagementCapabilities";
import { consumeBookingManagementRateLimit } from "@/shared/booking/bookingManagementRateLimit";
import { noShowCardDecision } from "@/shared/integrations/square/noshow";
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
    db.from("bookings" as never).select("id,status,noshow_card_id").eq("id", bookingId).eq("salon_id", salonId).maybeSingle(),
    db.from("salons" as never).select("name,currency_code").eq("id", salonId).maybeSingle(),
  ]);
  if (bookingResult.error || salonResult.error || !bookingResult.data || !salonResult.data) {
    return json({ ok: false, code: "management_unavailable" }, 503);
  }
  const booking = bookingResult.data as { status: string; noshow_card_id: string | null };
  const salon = salonResult.data as { name: string | null; currency_code: string | null };
  const decision = await noShowCardDecision(bookingId);
  return json({
    ok: true, bookingId, managementToken: token, salonName: salon.name ?? "",
    currencyCode: String(salon.currency_code || "USD").trim().toUpperCase() || "USD",
    alreadySaved: Boolean(booking.noshow_card_id), cancelled: booking.status === "cancelled",
    cardRequired: decision.required,
  });
}
