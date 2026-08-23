import { NextResponse } from "next/server";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { consumePublicRequestRateLimit } from "@/shared/security/publicServerActionRateLimit";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CUSTOMER_OUTCOMES = new Set(["dismissed", "ignored", "timeout"]);

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

export async function POST(req: Request) {
  if (!isSameOriginMutation(req)) return response({ ok: false }, 403);

  const rate = await consumePublicRequestRateLimit({
    request: req,
    scope: "customer-upsell-outcome",
    ipLimits: [[30, 60], [120, 3_600]],
  });
  if (rate !== "allowed") {
    return response(
      { ok: false, error: rate === "limited" ? "rate_limited" : "temporarily_unavailable" },
      rate === "limited" ? 429 : 503,
    );
  }

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
  const otpSessionId = typeof body.otp_session_id === "string" ? body.otp_session_id.trim() : "";
  const salonId = typeof body.salon_id === "string" ? body.salon_id.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const outcome = typeof body.outcome === "string" ? body.outcome.trim() : "";
  const phoneResult = validateGuestPhone(phone);
  if (
    !UUID_RE.test(sessionId) || !UUID_RE.test(otpSessionId) ||
    !UUID_RE.test(salonId) || !phoneResult.ok || !CUSTOMER_OUTCOMES.has(outcome)
  ) return response({ ok: false, error: "invalid_request" }, 400);

  // A browser cannot self-assert acceptance or revenue. Those outcomes must be
  // attached by the authoritative booking/quote receipt path.
  if (body.added_revenue_cents !== undefined) {
    return response({ ok: false, error: "invalid_request" }, 400);
  }

  const db = createServiceRoleClient();
  const { data: otpValid, error: otpError } = await db.rpc(
    "validate_phone_otp_session",
    { p_session_id: otpSessionId, p_salon_id: salonId, p_phone: phoneResult.digits },
  );
  if (otpError) return response({ ok: false, error: "temporarily_unavailable" }, 503);
  if (otpValid !== true) return response({ ok: false, error: "not_authorized" }, 401);

  const { data, error } = await db
    .from("ai_upsell_log")
    .update({
      outcome,
      outcome_at: new Date().toISOString(),
    })
    .eq("salon_id", salonId)
    .eq("client_phone", phoneResult.digits)
    .eq("session_id", sessionId)
    .eq("outcome", "shown")
    .select("id")
    .maybeSingle();
  if (error) return response({ ok: false, error: "temporarily_unavailable" }, 503);
  if (!data) return response({ ok: false, error: "not_found" }, 404);

  return response({ ok: true });
}
