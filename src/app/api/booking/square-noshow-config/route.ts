import { NextResponse } from "next/server";

import { inspectBookingManagementCapability } from "@/shared/booking/bookingManagementCapabilities";
import { consumeBookingManagementRateLimit } from "@/shared/booking/bookingManagementRateLimit";
import { noShowCardDecision } from "@/shared/integrations/square/noshow";
import { getSquareConfig } from "@/shared/integrations/square/client";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { resolvePaymentProvider } from "@/shared/integrations/payments";

export const runtime = "nodejs";
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache",
  "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow",
} as const;
const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: PRIVATE_HEADERS });

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token")?.trim() ?? "";
  if (!token) return json({ required: false, code: "invalid_request" }, 400);
  const rate = await consumeBookingManagementRateLimit({ request, tokenId: token, action: "card_manage", phase: "inspect" });
  if (rate !== "allowed") return json({ required: false, code: rate === "limited" ? "rate_limited" : "management_unavailable" }, rate === "limited" ? 429 : 503);
  const inspected = await inspectBookingManagementCapability({ tokenId: token, expectedAction: "card_manage" });
  if (!inspected.ok) return json({ required: false, code: inspected.code }, inspected.code === "management_unavailable" ? 503 : 404);
  try {
    const decision = await noShowCardDecision(inspected.inspection.context.bookingId, { strict: true });
    if (!decision.required) return json({ required: false });
    const provider = await resolvePaymentProvider(inspected.inspection.context.salonId);
    if (!provider) return json({ required: false, code: "provider_configuration_invalid" }, 503);
    if (provider.kind === "stripe") {
      return json({ required: true, provider: "stripe", feeCents: decision.feeCents });
    }
    const cfg = await getSquareConfig(createServiceRoleClient(), inspected.inspection.context.salonId);
    if (!cfg.applicationId || !cfg.locationId) return json({ required: false, code: "provider_configuration_invalid" }, 503);
    return json({
      required: true,
      provider: "square",
      feeCents: decision.feeCents,
      applicationId: cfg.applicationId,
      locationId: cfg.locationId,
      environment: cfg.environment,
    });
  } catch {
    return json({ required: false, code: "provider_configuration_invalid" }, 503);
  }
}
