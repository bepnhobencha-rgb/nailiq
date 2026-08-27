import { NextResponse } from "next/server";

import { saveCardWithManagementCapability } from "@/shared/booking/bookingCardManagement";
import { consumeBookingManagementRateLimit } from "@/shared/booking/bookingManagementRateLimit";
import { readJsonObjectWithLimit } from "@/shared/security/readJsonObjectWithLimit";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";
import { v1AllowsNoShowCardOnFile } from "@/shared/release/v1IntegrationScope";

export const runtime = "nodejs";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache",
  "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow",
} as const;
const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: PRIVATE_HEADERS });

/** Saves a provider token under a durable card_manage operation. No charge. */
export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return json({ ok: false, code: "forbidden" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json({ ok: false, code: "invalid_request" }, 400);
  }
  const body = await readJsonObjectWithLimit(request, 4096);
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  const sourceId = typeof body?.sourceId === "string" ? body.sourceId.trim() : "";
  const provider = body?.provider === "square" || body?.provider === "stripe" ? body.provider : null;
  const verificationToken = typeof body?.verificationToken === "string"
    ? body.verificationToken.trim()
    : undefined;
  if (!token || !requestId || !sourceId || !provider || body?.consent !== true) {
    return json({ ok: false, code: "invalid_request" }, 400);
  }
  // A stale capability must not claim an operation while the narrow card-on-file
  // gate is disabled. Keep this ahead of rate-limit/database/provider work.
  if (!v1AllowsNoShowCardOnFile()) {
    return json({ ok: false, code: "phase_2_not_available" }, 503);
  }
  const rate = await consumeBookingManagementRateLimit({
    request, tokenId: token, action: "card_manage", phase: "mutate",
  });
  if (rate !== "allowed") {
    return json({ ok: false, code: rate === "limited" ? "rate_limited" : "management_unavailable" }, rate === "limited" ? 429 : 503);
  }
  const result = await saveCardWithManagementCapability({
    tokenId: token,
    requestId,
    provider,
    sourceToken: sourceId,
    verificationToken,
  });
  const status = result.ok ? 200
    : result.code === "invalid_request" ? 400
      : result.code === "invalid_token" || result.code === "expired_or_revoked" ? 404
        : result.code === "idempotency_mismatch" || result.code === "in_flight" || result.code === "operation_conflict" ? 409
          : 503;
  return json(result as unknown as Record<string, unknown>, status);
}
