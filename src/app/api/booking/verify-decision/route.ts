import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import type { VerifyDecisionResponse } from "@/shared/types/booking";
import { consumePublicRequestRateLimit } from "@/shared/security/publicServerActionRateLimit";
export type { VerificationAction, VerifyDecisionResponse } from "@/shared/types/booking";

export async function POST(req: NextRequest) {
  try {
    const ipRate = await consumePublicRequestRateLimit({
      request: req,
      scope: "booking-verify-decision",
      ipLimits: [[30, 60], [200, 3_600]],
    });
    if (ipRate !== "allowed") {
      return NextResponse.json(
        { error: ipRate === "limited" ? "rate_limited" : "temporarily_unavailable" },
        { status: ipRate === "limited" ? 429 : 503 },
      );
    }
    const body = (await req.json()) as {
      salon_id?: string;
      client_phone?: string;
      client_email?: string | null;
      service_ids?: string[];
      subtotal_cents?: number;
    };

    const { salon_id, client_phone, client_email, service_ids, subtotal_cents } = body;
    if (!salon_id || !client_phone) {
      return NextResponse.json({ error: "missing_params" }, { status: 400 });
    }

    const identityRate = await consumePublicRequestRateLimit({
      request: req,
      scope: "booking-verify-decision-identity",
      identity: [salon_id, client_phone.replace(/\D/g, "")],
      ipLimits: [],
      identityLimits: [[10, 900], [30, 86_400]],
    });
    if (identityRate !== "allowed") {
      return NextResponse.json(
        { error: identityRate === "limited" ? "rate_limited" : "temporarily_unavailable" },
        { status: identityRate === "limited" ? 429 : 503 },
      );
    }

    const supabase = createServiceRoleClient();
    const { data, error } = await supabase.rpc("determine_booking_verification", {
      p_salon_id:       salon_id,
      p_client_phone:   client_phone.replace(/\D/g, ""),
      p_has_email:      Boolean(client_email?.trim()),
      p_service_ids:    service_ids ?? [],
      p_subtotal_cents: subtotal_cents ?? 0,
    });

    if (error) {
      console.error("[verify-decision] RPC error", error);
      // Fail open: if RPC errors, don't block the booking
      return NextResponse.json<VerifyDecisionResponse>({
        action: "none",
        risk_score: 0,
        deposit_amount_cents: 0,
        reason: "rpc_error",
      });
    }

    const result = data as VerifyDecisionResponse;
    return NextResponse.json<VerifyDecisionResponse>(result);
  } catch (e) {
    console.error("[verify-decision]", e);
    return NextResponse.json<VerifyDecisionResponse>({
      action: "none",
      risk_score: 0,
      deposit_amount_cents: 0,
      reason: "error",
    });
  }
}
