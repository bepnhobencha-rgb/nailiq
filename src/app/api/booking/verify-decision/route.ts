import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type VerificationAction =
  | "none"
  | "otp_optional"
  | "otp_required"
  | "deposit_required"
  | "deposit_or_otp";

export type VerifyDecisionResponse = {
  action: VerificationAction;
  risk_score: number;
  deposit_amount_cents: number;
  reason: string;
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      salon_id?: string;
      client_phone?: string;
      service_ids?: string[];
      subtotal_cents?: number;
    };

    const { salon_id, client_phone, service_ids, subtotal_cents } = body;
    if (!salon_id || !client_phone) {
      return NextResponse.json({ error: "missing_params" }, { status: 400 });
    }

    const supabase = createServiceRoleClient();
    const { data, error } = await supabase.rpc("determine_booking_verification", {
      p_salon_id:       salon_id,
      p_client_phone:   client_phone.replace(/\D/g, ""),
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
