import { NextResponse, type NextRequest } from "next/server";
import { clientIp } from "@/shared/lib/inAppRateLimit";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  publicBookingQuoteRateKey,
  publicBookingQuoteRequestSchema,
  resolvePublicBookingQuote,
} from "@/shared/booking/publicBookingQuoteServer";

export const dynamic = "force-dynamic";

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  const allowed = new Set<string>([request.nextUrl.origin]);
  for (const candidate of [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
    process.env.VERCEL_BRANCH_URL ? `https://${process.env.VERCEL_BRANCH_URL}` : null,
  ]) {
    if (!candidate) continue;
    try {
      allowed.add(new URL(candidate).origin);
    } catch {
      // Misconfigured deployment origin is not an authorization grant.
    }
  }
  return allowed.has(origin);
}

async function rateLimitAllowed(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean | null> {
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "rate_limit_hit",
      {
        p_key: key,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      },
    );
    if (error || typeof data !== "boolean") return null;
    return data;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { ok: false, code: "forbidden" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > 8_192) {
    return NextResponse.json(
      { ok: false, code: "invalid_request" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const ipAllowed = await rateLimitAllowed(
    publicBookingQuoteRateKey("ip", clientIp(request)),
    60,
    300,
  );
  if (ipAllowed === null) {
    return NextResponse.json(
      { ok: false, code: "quote_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!ipAllowed) {
    return NextResponse.json(
      { ok: false, code: "rate_limited" },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "300" } },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = publicBookingQuoteRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const phoneAllowed = await rateLimitAllowed(
    publicBookingQuoteRateKey(
      "phone",
      `${parsed.data.salonId}:${parsed.data.clientPhone}`,
    ),
    30,
    300,
  );
  if (phoneAllowed === null) {
    return NextResponse.json(
      { ok: false, code: "quote_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!phoneAllowed) {
    return NextResponse.json(
      { ok: false, code: "rate_limited" },
      {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": "300" },
      },
    );
  }

  const result = await resolvePublicBookingQuote(parsed.data);
  const status = result.ok
    ? 200
    : result.code === "invalid_request"
      ? 400
      : result.code === "voucher_invalid"
        ? 422
        : 503;
  return NextResponse.json(result, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
