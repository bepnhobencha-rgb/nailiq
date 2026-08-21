import { NextResponse } from "next/server";

import { removeCardWithManagementCapability } from "@/shared/booking/bookingCardManagement";
import { consumeBookingManagementRateLimit } from "@/shared/booking/bookingManagementRateLimit";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";
import { readJsonObjectWithLimit } from "@/shared/security/readJsonObjectWithLimit";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache",
  "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow",
} as const;
const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: PRIVATE_HEADERS });

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return json({ ok: false, code: "forbidden" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return json({ ok: false, code: "invalid_request" }, 400);
  const body = await readJsonObjectWithLimit(request, 1024) as {
    token?: unknown; requestId?: unknown; expectedCardFingerprint?: unknown;
  } | null;
  if (!body) return json({ ok: false, code: "invalid_request" }, 400);
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  const expectedCardFingerprint = typeof body?.expectedCardFingerprint === "string"
    ? body.expectedCardFingerprint.trim()
    : "";
  if (!token || !requestId || !/^[0-9a-f]{64}$/.test(expectedCardFingerprint)) {
    return json({ ok: false, code: "invalid_request" }, 400);
  }
  const rate = await consumeBookingManagementRateLimit({ request, tokenId: token, action: "card_manage", phase: "mutate" });
  if (rate !== "allowed") return json({ ok: false, code: rate === "limited" ? "rate_limited" : "management_unavailable" }, rate === "limited" ? 429 : 503);
  const result = await removeCardWithManagementCapability({
    tokenId: token,
    requestId,
    expectedCardFingerprint,
  });
  const status = result.ok ? 200
    : result.code === "invalid_request" ? 400
      : result.code === "in_flight" || result.code === "idempotency_mismatch" || result.code === "stale_card" ? 409
        : result.code === "invalid_token" || result.code === "expired_or_revoked" ? 404
          : 503;
  return json(result as unknown as Record<string, unknown>, status);
}
