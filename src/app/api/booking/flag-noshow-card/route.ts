import { NextResponse } from "next/server";

import { consumeBookingManagementRateLimit } from "@/shared/booking/bookingManagementRateLimit";
import { readJsonObjectWithLimit } from "@/shared/security/readJsonObjectWithLimit";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";

/**
 * Retired: trusted booking creation now evaluates no-show policy and mints a
 * card_manage capability server-side. A browser may never flag an arbitrary
 * booking by id.
 */
export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json({ ok: false, code: "forbidden" }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return NextResponse.json({ ok: false, code: "invalid_request" }, { status: 400 });
  }
  const body = await readJsonObjectWithLimit(request, 1024);
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  if (!token || !requestId) return NextResponse.json({ ok: false, code: "invalid_request" }, { status: 400 });
  const rate = await consumeBookingManagementRateLimit({
    request, tokenId: token, action: "card_manage", phase: "mutate",
  });
  if (rate !== "allowed") {
    return NextResponse.json({ ok: false, code: rate === "limited" ? "rate_limited" : "management_unavailable" }, { status: rate === "limited" ? 429 : 503 });
  }
  return NextResponse.json({ ok: false, code: "route_retired" }, { status: 410 });
}
