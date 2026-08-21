import { NextResponse } from "next/server";

import {
  claimWaitlistSlot,
  parseWaitlistClaimToken,
} from "@/shared/booking/waitlistClaim";
import { consumeBookingManagementRateLimit } from "@/shared/booking/bookingManagementRateLimit";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

async function readBoundedJson(request: Request): Promise<Record<string, unknown> | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > 1024) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    if (total === 0) return null;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(merged)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return json({ ok: false, reason: "invalid_request" }, 403);
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json({ ok: false, reason: "invalid_request" }, 400);
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isFinite(length) || length <= 0 || length > 1024) {
      return json({ ok: false, reason: "invalid_request" }, 400);
    }
  }

  const body = await readBoundedJson(request);
  if (!body) {
    return json({ ok: false, reason: "invalid_request" }, 400);
  }

  const token = parseWaitlistClaimToken(
    "token" in body
      ? body.token
      : null,
  );
  const requestId = parseWaitlistClaimToken(
    "requestId" in body
      ? body.requestId
      : null,
  );
  if (!token || !requestId) return json({ ok: false, reason: "unavailable" }, 400);

  const rate = await consumeBookingManagementRateLimit({
    request,
    tokenId: token,
    action: "waitlist_claim",
    phase: "mutate",
  });
  if (rate !== "allowed") {
    return json({ ok: false, reason: rate === "limited" ? "rate_limited" : "temporarily_unavailable" }, rate === "limited" ? 429 : 503);
  }

  const result = await claimWaitlistSlot(token, requestId);
  if (!result.ok) {
    if (result.reason === "error") {
      return json({ ok: false, reason: "temporarily_unavailable" }, 503);
    }
    // Invalid, expired, already claimed, and concurrent losers intentionally
    // share one response so the token cannot be used as a lifecycle oracle.
    return json({ ok: false, reason: "unavailable" }, 409);
  }

  return json({ ok: true, outcome: result.outcome }, 200);
}
