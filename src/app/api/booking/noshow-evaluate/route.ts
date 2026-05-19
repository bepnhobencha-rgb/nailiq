import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { evaluateDeposit } from "@/shared/noshow/evaluateDeposit";
import { scoreNoShowRisk } from "@/shared/noshow/scoreNoShowRisk";

/** Called fire-and-forget from submitPublicBooking after a booking insert. */
export async function POST(req: Request) {
  const secret = (process.env.INTERNAL_API_SECRET ?? "").trim();
  if (secret && req.headers.get("x-internal-secret") !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let body: {
    bookingId: string;
    clientName: string;
    serviceName: string;
    salonId: string;
    startTimeUtc: string;
    isNewCustomer: boolean;
    visitCount: number;
    noShowCount: number;
    isVip: boolean;
    hasEmail: boolean;
    svcPriceCents: number;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  try {
    const supabase = createServiceRoleClient();

    const { data: salonSettings } = await supabase
      .from("salons" as never)
      .select("deposit_high_value_cents")
      .eq("id", body.salonId)
      .maybeSingle();
    const highValueThreshold =
      (salonSettings as { deposit_high_value_cents?: number } | null)
        ?.deposit_high_value_cents ?? 10000;

    const depositDecision = evaluateDeposit({
      isNewCustomer: body.isNewCustomer,
      previousNoShowCount: body.noShowCount,
      isVip: body.isVip,
      servicePriceCents: body.svcPriceCents,
      highValueThresholdCents: highValueThreshold,
    });

    const [riskResult] = await Promise.allSettled([
      scoreNoShowRisk({
        clientName: body.clientName,
        serviceName: body.serviceName,
        startTimeUtc: body.startTimeUtc,
        isNewCustomer: body.isNewCustomer,
        visitCount: body.visitCount,
        noShowCount: body.noShowCount,
        bookingSource: "public_booking",
        hasEmail: body.hasEmail,
        hasPhone: true,
      }),
    ]);

    const riskScore =
      riskResult.status === "fulfilled" ? riskResult.value.score : null;

    await supabase
      .from("bookings" as never)
      .update({
        deposit_required: depositDecision.required,
        deposit_amount_cents: depositDecision.required
          ? depositDecision.amountCents
          : null,
        deposit_reason: depositDecision.reason,
        deposit_status: depositDecision.required ? "required" : "not_required",
        no_show_risk_score: riskScore,
      })
      .eq("id", body.bookingId);

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[noshow-evaluate] failed", e);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
