import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { evaluateDeposit } from "@/shared/noshow/evaluateDeposit";
import { scoreNoShowRisk } from "@/shared/noshow/scoreNoShowRisk";
import { resolveVertical } from "@/shared/verticals/registry";

export type EvaluateBookingNoShowInput = {
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

/**
 * Compute + persist a booking's deposit requirement, AI no-show risk score, and
 * the "must leave a card" flag. Server-only (uses the Anthropic SDK + the
 * service-role client). Best-effort: never throws to the caller.
 *
 * Extracted from the noshow-evaluate route so it can run directly inside a
 * server action — the browser cannot authenticate to the internal route (it has
 * no INTERNAL_API_SECRET), which silently left every online booking's risk
 * unscored. Calling this server-side removes the HTTP hop entirely.
 */
export async function evaluateBookingNoShow(
  body: EvaluateBookingNoShowInput,
): Promise<void> {
  try {
    const supabase = createServiceRoleClient();

    const { data: salonSettings } = await supabase
      .from("salons" as never)
      .select(
        "deposit_high_value_cents, vertical, deposit_pct_no_show, deposit_pct_high_value, deposit_pct_new_customer",
      )
      .eq("id", body.salonId)
      .maybeSingle();
    const s = (salonSettings ?? {}) as {
      deposit_high_value_cents?: number;
      vertical?: string | null;
      deposit_pct_no_show?: number;
      deposit_pct_high_value?: number;
      deposit_pct_new_customer?: number;
    };
    const highValueThreshold = s.deposit_high_value_cents ?? 10000;
    const businessDescriptor = resolveVertical(s.vertical).aiDescriptor;

    const depositDecision = evaluateDeposit({
      isNewCustomer: body.isNewCustomer,
      previousNoShowCount: body.noShowCount,
      isVip: body.isVip,
      servicePriceCents: body.svcPriceCents,
      highValueThresholdCents: highValueThreshold,
      pctNoShow: s.deposit_pct_no_show,
      pctHighValue: s.deposit_pct_high_value,
      pctNewCustomer: s.deposit_pct_new_customer,
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
        businessDescriptor,
      }),
    ]);

    const riskScore =
      riskResult.status === "fulfilled" ? riskResult.value.score : null;

    // No-show card decision (the modern "charge only on a confirmed no-show"
    // mechanism). Computed BEFORE the deposit write so a required card can
    // SUPERSEDE the up-front deposit. The two protections were independent and
    // both fired for a returning no-show customer — demanding a deposit AND a
    // card for the very same risk. The card already covers the no-show, so when
    // a card is required we skip the deposit; the deposit stays only as the
    // fallback for salons that cannot capture a card (no provider / protection
    // off). New / high-risk + provider connected + protection on.
    let cardRequired = false;
    try {
      const { noShowCardDecision, autoAttachReturningCard } = await import(
        "@/shared/integrations/square/noshow"
      );
      // Returning customer who already left a card → carry it forward so this
      // visit stays protected without re-asking. Runs BEFORE the decision: once
      // attached, noShowCardDecision returns "card already saved" (required:false).
      await autoAttachReturningCard(body.bookingId);
      cardRequired = (await noShowCardDecision(body.bookingId)).required;
    } catch (e) {
      console.error("[evaluateBookingNoShow] card decision", e);
    }

    // Card supersedes deposit: keep the deposit only when no card is required.
    const depositActive = depositDecision.required && !cardRequired;

    await supabase
      .from("bookings" as never)
      .update({
        deposit_required: depositActive,
        deposit_amount_cents: depositActive
          ? depositDecision.amountCents
          : null,
        deposit_reason: depositActive ? depositDecision.reason : null,
        deposit_status: depositActive ? "required" : "not_required",
        no_show_risk_score: riskScore,
        noshow_card_required: cardRequired,
      })
      .eq("id", body.bookingId);
  } catch (e) {
    console.error("[evaluateBookingNoShow] failed", e);
  }
}
