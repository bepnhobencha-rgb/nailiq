import { NextResponse } from "next/server";

import { createStripeSetupWithManagementCapability } from "@/shared/booking/bookingCardManagement";
import { consumeBookingManagementRateLimit } from "@/shared/booking/bookingManagementRateLimit";
import { readJsonObjectWithLimit } from "@/shared/security/readJsonObjectWithLimit";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";

export const runtime = "nodejs";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache",
  "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow",
} as const;
const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: PRIVATE_HEADERS });

/** Creates/replays one durable Stripe SetupIntent and returns its successor save token. */
export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return json({ ok: false, code: "forbidden" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json({ ok: false, code: "invalid_request" }, 400);
  }
  const body = await readJsonObjectWithLimit(request, 1024);
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  if (!token || !requestId) return json({ ok: false, code: "invalid_request" }, 400);
  const rate = await consumeBookingManagementRateLimit({
    request, tokenId: token, action: "card_manage", phase: "mutate",
  });
  if (rate !== "allowed") {
    return json({ ok: false, code: rate === "limited" ? "rate_limited" : "management_unavailable" }, rate === "limited" ? 429 : 503);
  }
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim() ?? "";
  if (!publishableKey) return json({ ok: false, code: "provider_configuration_invalid" }, 503);
  const result = await createStripeSetupWithManagementCapability({ tokenId: token, requestId });
  const status = result.ok ? 200
    : result.code === "invalid_request" ? 400
      : result.code === "invalid_token" || result.code === "expired_or_revoked" ? 404
        : result.code === "idempotency_mismatch" || result.code === "in_flight" || result.code === "operation_conflict" ? 409
          : 503;
  return json({
    ...result,
    required: result.ok,
    clientSecret: result.clientSecret,
    finalizeToken: result.finalizeTokenId,
    publishableKey: result.ok ? publishableKey : undefined,
  } as Record<string, unknown>, status);
}
