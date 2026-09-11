import { NextResponse } from "next/server";

import { inspectCardRecovery, loadCardRecoveryConsent } from "@/shared/booking/bookingCardRecovery";
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
  const inspected = await inspectCardRecovery(token);
  if (!inspected.ok) return json({ ok: false, code: inspected.code }, inspected.code === "management_unavailable" ? 503 : 404);

  const { bookingId, salonId } = inspected.context;
  const db = createServiceRoleClient();
  const [bookingResult, salonResult] = await Promise.all([
    db.from("bookings" as never).select("id,status,start_time_utc,services!bookings_service_id_fkey(name)").eq("id", bookingId).eq("salon_id", salonId).maybeSingle(),
    db.from("salons" as never).select("name,currency_code,brand_color,theme_mode,timezone").eq("id", salonId).maybeSingle(),
  ]);
  if (bookingResult.error || salonResult.error || !bookingResult.data || !salonResult.data) {
    return json({ ok: false, code: "management_unavailable" }, 503);
  }
  const booking = bookingResult.data as { status: string; start_time_utc: string; services: { name: string } | null };
  const salon = salonResult.data as { name: string | null; currency_code: string | null; brand_color: string | null; theme_mode: string | null; timezone: string | null };
  const consent = inspected.context.canRefreshConsent ? await loadCardRecoveryConsent(inspected.context) : null;
  return json({
    ok: true, bookingId, managementToken: token, salonName: salon.name ?? "",
    brandColor: salon.brand_color, themeMode: salon.theme_mode === "light" ? "light" : "dark", timezone: salon.timezone ?? "UTC",
    currencyCode: String(salon.currency_code || "USD").trim().toUpperCase() || "USD",
    alreadySaved: inspected.context.protectionStatus === "saved", cancelled: booking.status === "cancelled",
    cardRequired: inspected.context.protectionStatus !== "not_required",
    protectionStatus: inspected.context.protectionStatus, canRetry: inspected.context.canRetry, canRefreshConsent: inspected.context.canRefreshConsent,
    consent: consent ? { version: consent.version, policyEn: consent.policyEn, policyVi: consent.policyVi } : null,
    expiresAt: inspected.context.expiresAt, bookingTime: booking.start_time_utc, service: booking.services?.name ?? "",
  });
}
