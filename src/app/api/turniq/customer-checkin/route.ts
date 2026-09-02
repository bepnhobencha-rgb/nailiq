import { NextResponse } from "next/server";

import type { TurnIqCustomerCheckInInput } from "@/shared/turniq/customerCheckIn";
import { recordTurnIqCustomerCheckInShadow } from "@/shared/turniq/customerCheckInServer";
import { consumePublicRequestRateLimit } from "@/shared/security/publicServerActionRateLimit";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4_096;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function response(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

async function boundedJson(request: Request): Promise<Record<string, unknown> | null> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return null;
  const raw = await request.text().catch(() => "");
  if (!raw || new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function inputFromBody(body: Record<string, unknown>): {
  capabilityToken: string;
  input: TurnIqCustomerCheckInInput;
} | null {
  const capabilityToken = typeof body.capabilityToken === "string"
    ? body.capabilityToken.trim().toLowerCase()
    : "";
  if (!UUID_RE.test(capabilityToken)) return null;
  const requested = body.requestedTechnician;
  if (
    requested !== null
    && (
      !requested
      || typeof requested !== "object"
      || Array.isArray(requested)
    )
  ) return null;
  const requestedRow = requested as Record<string, unknown> | null;
  return {
    capabilityToken,
    input: {
      commandId: typeof body.commandId === "string" ? body.commandId : "",
      channel: body.channel as TurnIqCustomerCheckInInput["channel"],
      visitKind: body.visitKind as TurnIqCustomerCheckInInput["visitKind"],
      serviceId: typeof body.serviceId === "string" ? body.serviceId : "",
      partySize: typeof body.partySize === "number" ? body.partySize : Number.NaN,
      submittedAt: typeof body.submittedAt === "string" ? body.submittedAt : "",
      actorSessionFingerprint: typeof body.actorSessionFingerprint === "string"
        ? body.actorSessionFingerprint
        : "",
      requestedTechnician: requestedRow
        ? {
            staffId: typeof requestedRow.staffId === "string"
              ? requestedRow.staffId
              : "",
            explicitlyConfirmed: requestedRow.explicitlyConfirmed as true,
          }
        : null,
    },
  };
}

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return response({ ok: false }, 403);

  const ipRate = await consumePublicRequestRateLimit({
    request,
    scope: "turniq-customer-checkin",
    ipLimits: [[30, 60], [300, 3_600]],
  });
  if (ipRate !== "allowed") {
    return response(
      { ok: false, error: ipRate === "limited" ? "rate_limited" : "temporarily_unavailable" },
      ipRate === "limited" ? 429 : 503,
    );
  }

  const body = await boundedJson(request);
  const parsed = body ? inputFromBody(body) : null;
  if (!parsed) return response({ ok: false, error: "invalid_request" }, 400);

  const capabilityRate = await consumePublicRequestRateLimit({
    request,
    scope: "turniq-customer-checkin-capability",
    identity: [parsed.capabilityToken],
    ipLimits: [],
    identityLimits: [[12, 60], [100, 3_600]],
  });
  if (capabilityRate !== "allowed") {
    return response(
      { ok: false, error: capabilityRate === "limited" ? "rate_limited" : "temporarily_unavailable" },
      capabilityRate === "limited" ? 429 : 503,
    );
  }

  const result = await recordTurnIqCustomerCheckInShadow(
    parsed.capabilityToken,
    parsed.input,
  );
  if (!result.ok) {
    const status = result.code === "invalid_request" ? 400
      : result.code === "invalid_capability" || result.code === "capability_unavailable" ? 401
      : result.code === "idempotency_conflict" ? 409
      : result.code === "feature_disabled" ? 404
      : result.code === "temporarily_unavailable" ? 503
      : 409;
    return response({ ok: false, error: result.code }, status);
  }

  return response({
    ok: true,
    replayed: result.replayed,
    status: result.status,
    nextRoute: result.nextRoute,
    intakeFingerprint: result.intakeFingerprint,
    message: result.message,
  });
}
