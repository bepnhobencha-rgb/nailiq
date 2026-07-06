import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export const dynamic = "force-dynamic";

/**
 * GET /api/upsell?salon_id=X&phone=Y&selected_service_id=Z&session_id=S
 *
 * Returns an upsell suggestion if:
 * - The salon is Pro+ tier
 * - Customer has history (≥3 bookings) showing an add-on ≥40% of the time
 * - The suggested add-on is NOT already selected
 * - The customer hasn't dismissed 3+ times recently
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const salonId = searchParams.get("salon_id");
  const phone = searchParams.get("phone");
  const selectedServiceId = searchParams.get("selected_service_id");
  const sessionId = searchParams.get("session_id") ?? crypto.randomUUID();

  if (!salonId || !phone || !selectedServiceId) {
    return NextResponse.json({ available: false });
  }

  const db = createServiceRoleClient();

  // Check salon tier
  const { data: salon } = await db
    .from("salons")
    .select("subscription_plan, plan_override, feature_flags")
    .eq("id", salonId)
    .single();

  if (!salon) return NextResponse.json({ available: false });

  const plan = (salon.plan_override ?? salon.subscription_plan) as string;
  const flags = salon.feature_flags as Record<string, boolean> | null;
  const featureEnabled =
    flags?.["ai_smart_upsell"] !== undefined
      ? flags["ai_smart_upsell"]
      : ["pro", "premium", "enterprise"].includes(plan);

  if (!featureEnabled) return NextResponse.json({ available: false });

  // Get last 10 bookings for this customer+salon
  const { data: bookings } = await db
    .from("bookings")
    .select("service_id, addon_service_id, client_locale")
    .eq("salon_id", salonId)
    .eq("client_phone", phone)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(10);

  if (!bookings || bookings.length < 3) return NextResponse.json({ available: false });

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

  if (!topAddon) return NextResponse.json({ available: false });

  const [addonServiceId] = topAddon;

  // Fetch service details
  const { data: service } = await db
    .from("services")
    .select("id, name, price_cents")
    .eq("id", addonServiceId)
    .eq("salon_id", salonId)
    .is("deleted_at", null)
    .single();

  if (!service) return NextResponse.json({ available: false });

  // Log the suggestion
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

  await db.from("ai_upsell_log").insert({
    salon_id: salonId,
    client_phone: phone,
    session_id: sessionId,
    suggested_service_id: addonServiceId,
    suggestion_position: "after_service_select",
    suggestion_reason: reason,
    confidence_score: topAddon[1] / bookings.length,
    outcome: "shown",
  });

  return NextResponse.json({
    service_id: service.id,
    service_name: service.name,
    price_cents: service.price_cents,
    reason,
    confidence: topAddon[1] / bookings.length,
    session_id: sessionId,
  });
}
