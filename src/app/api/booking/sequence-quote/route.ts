import { NextResponse, type NextRequest } from "next/server";

import {
  bookingSequenceRateKey,
  quotePublicBookingSequence,
} from "@/shared/booking/bookingSequenceServer";
import { parseSequenceBookingIntent } from "@/shared/booking/bookingSequence";
import { loadPublicBookingSequenceReadiness } from "@/shared/booking/bookingSequenceReadiness";
import { clientIp } from "@/shared/lib/inAppRateLimit";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { readJsonObjectWithLimit } from "@/shared/security/readJsonObjectWithLimit";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store" } as const;

function json(body: unknown, status: number, retryAfter?: string) {
  return NextResponse.json(body, {
    status,
    headers: { ...HEADERS, ...(retryAfter ? { "Retry-After": retryAfter } : {}) },
  });
}

async function rateLimitAllowed(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean | null> {
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "rate_limit_hit" as never,
      { p_key: key, p_limit: limit, p_window_seconds: windowSeconds } as never,
    );
    return error || typeof data !== "boolean" ? null : data;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOriginMutation(request)) {
    return json({ ok: false, code: "forbidden" }, 403);
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return json({ ok: false, code: "invalid_request" }, 400);
  }
  const ipRateAllowed = await rateLimitAllowed(
    bookingSequenceRateKey("ip", clientIp(request)),
    20,
    300,
  );
  if (ipRateAllowed == null) return json({ ok: false, code: "quote_unavailable" }, 503);
  if (!ipRateAllowed) return json({ ok: false, code: "rate_limited" }, 429, "300");

  const body = await readJsonObjectWithLimit(request, 16_384);
  const intent = parseSequenceBookingIntent(body);
  if (!intent) return json({ ok: false, code: "invalid_request" }, 400);

  const phoneRateAllowed = await rateLimitAllowed(
    bookingSequenceRateKey("phone", `${intent.salonId}:${intent.customer.phone}`),
    10,
    300,
  );
  if (phoneRateAllowed == null) return json({ ok: false, code: "quote_unavailable" }, 503);
  if (!phoneRateAllowed) return json({ ok: false, code: "rate_limited" }, 429, "300");

  const readiness = await loadPublicBookingSequenceReadiness(intent.salonId);
  if (!readiness.ok) return json({ ok: false, code: "booking_unavailable" }, 503);

  const result = await quotePublicBookingSequence(intent);
  return result.ok
    ? json(result, 200)
    : json(
        result,
        result.code === "invalid_request"
          ? 400
          : result.code === "quote_unavailable"
            ? 503
            : 409,
      );
}
