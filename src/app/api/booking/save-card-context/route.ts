import { NextResponse } from "next/server";

import { inspectCardRecovery, loadCardRecoveryConsent } from "@/shared/booking/bookingCardRecovery";
import { isCardCapturePaused } from "@/shared/booking/cardCapturePause";
import { consumeBookingManagementRateLimit } from "@/shared/booking/bookingManagementRateLimit";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache",
  "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow",
} as const;
const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: PRIVATE_HEADERS });

type ContextStage = "rate_metering" | "capability_inspection" | "client_configuration" | "metadata_read" | "booking_read" | "salon_read" | "consent_read";
function unavailable(stage: ContextStage, code?: unknown) {
  const safeCode = typeof code === "string" && ["57014", "53300", "08006", "42501", "42883", "42P01", "PGRST000", "PGRST002", "PGRST003", "PGRST202"].includes(code) ? code : "unclassified";
  try {
    console.warn(JSON.stringify({ event: "card_context_unavailable", status: 503, stage, code: safeCode }));
  } catch { /* Preserve the response if diagnostics fail. */ }
  return json({ ok: false, code: "management_unavailable" }, 503);
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token")?.trim() ?? "";
  if (!token) return json({ ok: false, code: "invalid_request" }, 400);
  let stage: ContextStage = "rate_metering";
  try {
    const rate = await consumeBookingManagementRateLimit({ request: req, tokenId: token, action: "card_manage", phase: "inspect" });
    if (rate !== "allowed") return rate === "limited" ? json({ ok: false, code: "rate_limited" }, 429) : unavailable(stage);
    stage = "capability_inspection";
    const inspected = await inspectCardRecovery(token);
    if (!inspected.ok) return inspected.code === "management_unavailable" ? unavailable(stage) : json({ ok: false, code: inspected.code }, 404);

    const { bookingId, salonId } = inspected.context;
    stage = "client_configuration";
    const db = createServiceRoleClient({ timeoutMs: 4_000 });
    stage = "metadata_read";
    const [bookingResult, salonResult] = await Promise.all([
      db.from("bookings" as never).select("id,status,start_time_utc,services!bookings_service_id_fkey(name)").eq("id", bookingId).eq("salon_id", salonId).maybeSingle(),
      db.from("salons" as never).select("name,currency_code,brand_color,theme_mode,timezone").eq("id", salonId).maybeSingle(),
    ]);
    if (bookingResult.error || !bookingResult.data) return unavailable("booking_read", bookingResult.error?.code);
    if (salonResult.error || !salonResult.data) return unavailable("salon_read", salonResult.error?.code);
    const booking = bookingResult.data as { status: string; start_time_utc: string; services: { name: string } | null };
    const salon = salonResult.data as { name: string | null; currency_code: string | null; brand_color: string | null; theme_mode: string | null; timezone: string | null };
    const capturePaused = isCardCapturePaused();
    stage = "consent_read";
    const consent = !capturePaused && (inspected.context.canRefreshConsent || inspected.context.canVerifyExistingCard) ? await loadCardRecoveryConsent(inspected.context) : null;
    return json({
      ok: true, bookingId, managementToken: token, salonName: salon.name ?? "",
      brandColor: salon.brand_color, themeMode: salon.theme_mode === "light" ? "light" : "dark", timezone: salon.timezone ?? "UTC",
      currencyCode: String(salon.currency_code || "USD").trim().toUpperCase() || "USD",
      alreadySaved: inspected.context.protectionStatus === "saved", cancelled: booking.status === "cancelled",
      cardRequired: inspected.context.protectionStatus !== "not_required",
      // A pause changes available actions, never the durable protection receipt.
      capturePaused, protectionStatus: inspected.context.protectionStatus,
      canRetry: !capturePaused && inspected.context.canRetry,
      canRefreshConsent: !capturePaused && inspected.context.canRefreshConsent,
      canVerifyExistingCard: !capturePaused && inspected.context.canVerifyExistingCard,
      consent: consent ? { version: consent.version, policyEn: consent.policyEn, policyVi: consent.policyVi } : null,
      expiresAt: inspected.context.expiresAt, bookingTime: booking.start_time_utc, service: booking.services?.name ?? "",
    });
  } catch {
    return unavailable(stage);
  }
}
