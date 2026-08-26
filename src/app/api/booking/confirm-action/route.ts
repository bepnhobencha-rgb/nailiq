import { NextResponse } from "next/server";

import { confirmBookingWithManagementCapability, inspectBookingManagementCapability } from "@/shared/booking/bookingManagementCapabilities";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";
import { consumeBookingManagementRateLimit } from "@/shared/booking/bookingManagementRateLimit";
import { readJsonObjectWithLimit } from "@/shared/security/readJsonObjectWithLimit";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function failureStatus(code: string): number {
  if (code === "invalid_request") return 400;
  if (code === "invalid_token") return 404;
  if (code === "expired_or_revoked" || code === "token_consumed") return 410;
  if (code === "management_unavailable" || code === "invalid_management_response") return 503;
  return 409;
}

function rateFailure(result: "allowed" | "limited" | "unavailable"): NextResponse | null {
  if (result === "allowed") return null;
  return json(
    { ok: false, code: result === "limited" ? "rate_limited" : "management_unavailable" },
    result === "limited" ? 429 : 503,
  );
}

/** Side-effect-free inspection. Link scanners may call this safely. */
export async function GET(request: Request): Promise<NextResponse> {
  const tokenId = new URL(request.url).searchParams.get("token")?.trim() ?? "";
  const limited = rateFailure(await consumeBookingManagementRateLimit({
    request,
    tokenId,
    action: "confirm",
    phase: "inspect",
  }));
  if (limited) return limited;
  const inspected = await inspectBookingManagementCapability({ tokenId, expectedAction: "confirm" });
  if (!inspected.ok) return json(inspected, failureStatus(inspected.code));
  return json({ ok: true, code: "valid", booking: inspected.inspection.booking });
}

/** Explicit customer action. Never expose this mutation through GET. */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginMutation(request)) return json({ ok: false, code: "forbidden" }, 403);

  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json({ ok: false, code: "invalid_request" }, 400);
  }

  const candidate = await readJsonObjectWithLimit(request, 1024);
  if (!candidate) return json({ ok: false, code: "invalid_request" }, 400);
  const tokenId = typeof candidate.token === "string" ? candidate.token.trim() : "";
  const requestId = typeof candidate.requestId === "string" ? candidate.requestId.trim() : "";
  const limited = rateFailure(await consumeBookingManagementRateLimit({
    request,
    tokenId,
    action: "confirm",
    phase: "mutate",
  }));
  if (limited) return limited;
  const result = await confirmBookingWithManagementCapability({ tokenId, requestId });
  if (!result.ok) return json(result, failureStatus(result.code));
  return json({
    ok: true,
    code: result.result.code,
    booking: {
      status: result.result.status,
      startTimeUtc: result.result.startTimeUtc,
      endTimeUtc: result.result.endTimeUtc,
      serviceName: result.result.serviceName,
      staffName: result.result.staffName,
      salonSlug: result.result.salonSlug,
      salonName: result.result.salonName,
      salonTimezone: result.result.salonTimezone,
    },
    idempotent: result.result.idempotent,
  });
}
