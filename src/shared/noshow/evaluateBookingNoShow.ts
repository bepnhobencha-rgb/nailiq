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
        "deposit_high_value_cents, vertical, deposit_pct_no_show, deposit_pct_high_value, deposit_pct_new_customer, noshow_deposit_escalation_threshold, name",
      )
      .eq("id", body.salonId)
      .maybeSingle();
    const s = (salonSettings ?? {}) as {
      deposit_high_value_cents?: number;
      vertical?: string | null;
      deposit_pct_no_show?: number;
      deposit_pct_high_value?: number;
      deposit_pct_new_customer?: number;
      noshow_deposit_escalation_threshold?: number | null;
      name?: string | null;
    };
    const highValueThreshold = s.deposit_high_value_cents ?? 10000;
    const businessDescriptor = resolveVertical(s.vertical).aiDescriptor;

    // Deposit is OPT-IN per salon — the admin "Deposit" toggle lives on
    // square_integrations.deposit_enabled. When off (or no Square row), never
    // flag a deposit; the salon relies on card-on-file (or no protection). This
    // is what makes the admin toggle actually STOP auto-deposits, not just block
    // the charge.
    const { data: sqRow } = await supabase
      .from("square_integrations" as never)
      .select("deposit_enabled")
      .eq("salon_id", body.salonId)
      .maybeSingle();
    const depositEnabled =
      (sqRow as { deposit_enabled?: boolean } | null)?.deposit_enabled === true;

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
    // Auto-escalation (opt-in): a customer with ≥ threshold PRIOR NO-SHOWS AT
    // THIS SALON pays an upfront pay-to-confirm DEPOSIT instead of card-on-file.
    // Counted PER-SALON to match the confirm + server card gates (a cross-salon
    // lifetime count would disagree with them about who's escalated). Computed
    // BEFORE the card step so an escalated customer is NEVER also given a card —
    // a card + a held deposit would double-protect → double-charge.
    const escThreshold = s.noshow_deposit_escalation_threshold;
    let escalated = false;
    if (escThreshold != null && depositEnabled) {
      const { data: bk } = await supabase
        .from("bookings" as never)
        .select("client_phone")
        .eq("id", body.bookingId)
        .maybeSingle();
      const phone = String(
        (bk as { client_phone?: string | null } | null)?.client_phone ?? "",
      ).trim();
      if (phone.length >= 8) {
        const { count } = await supabase
          .from("bookings" as never)
          .select("id", { count: "exact", head: true })
          .eq("salon_id", body.salonId)
          .eq("client_phone", phone)
          .eq("status", "no_show")
          .not("id", "eq", body.bookingId);
        escalated = (count ?? 0) >= Number(escThreshold);
      }
    }

    let cardRequired = false;
    try {
      const { noShowCardDecision, autoAttachReturningCard } = await import(
        "@/shared/integrations/square/noshow"
      );
      // Escalated → DEPOSIT only: do NOT attach/keep a card (the supersede guard
      // is bypassed by manual:true below, so attaching a card here would let
      // BOTH a deposit and the card collect = double-charge). Non-escalated:
      // carry forward a returning customer's card so they aren't re-asked.
      if (!escalated) {
        await autoAttachReturningCard(body.bookingId);
        cardRequired = (await noShowCardDecision(body.bookingId)).required;
      }
    } catch (e) {
      console.error("[evaluateBookingNoShow] card decision", e);
    }

    // SHADOW: run the AI no-show policy agent alongside the rule and RECORD what
    // it WOULD decide (no effect on this booking). Self-gated on the salon's
    // opt-in flag (feature_flags.ai_noshow_policy_shadow), so only opted-in
    // salons pay for the AI call. Best-effort — never blocks.
    try {
      const { runNoShowPolicyShadow } = await import("@/shared/noshow/agentNoShowPolicy");
      void runNoShowPolicyShadow(body.bookingId);
    } catch (e) {
      console.error("[evaluateBookingNoShow] shadow agent", e);
    }

    // Plain deposit applies only when deposits are on, a card isn't the
    // protection, AND we're not escalating (escalation uses the HELD deposit
    // path below, not this "required" write).
    const depositActive =
      depositEnabled && depositDecision.required && !cardRequired && !escalated;

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

    // Escalation: HOLD the slot (pending) + text/email a Square pay-link;
    // release-pending auto-cancels if unpaid. If the deposit can't be created,
    // FALL BACK to flagging "needs card" so an escalated booking is never left
    // silently unprotected (the card step was skipped at confirm).
    if (escalated) {
      let held = false;
      try {
        const { createDepositForBooking } = await import(
          "@/shared/integrations/square/deposits"
        );
        const dep = await createDepositForBooking(body.bookingId, {
          hold: true,
          manual: true,
        });
        if (dep.required && dep.url) {
          held = true;
          await sendEscalationDepositLink(
            supabase,
            body.bookingId,
            String(s.name ?? ""),
            dep.url,
            dep.amountCents ?? 0,
          );
        }
      } catch (e) {
        console.error("[evaluateBookingNoShow] escalation deposit", e);
      }
      if (!held) {
        await supabase
          .from("bookings" as never)
          .update({ noshow_card_required: true } as never)
          .eq("id", body.bookingId)
          .then(
            () => {},
            () => {},
          );
      }
    }
  } catch (e) {
    console.error("[evaluateBookingNoShow] failed", e);
  }
}

/** Text + email the pay-to-confirm deposit link to an escalated customer. The
 *  customer's locale isn't on `body`; default to the salon's site language is
 *  out of scope here, so we send EN (the link page itself is bilingual). */
async function sendEscalationDepositLink(
  supabase: ReturnType<typeof createServiceRoleClient>,
  bookingId: string,
  salonName: string,
  url: string,
  amountCents: number,
): Promise<void> {
  const { data } = await supabase
    .from("bookings" as never)
    .select("client_phone, client_email, client_name")
    .eq("id", bookingId)
    .maybeSingle();
  const b = (data ?? {}) as {
    client_phone?: string | null;
    client_email?: string | null;
    client_name?: string | null;
  };
  const salon = salonName.trim() || "NailIQ";
  const amount = `$${(amountCents / 100).toFixed(2)}`;
  const phone = String(b.client_phone ?? "").trim();
  if (phone) {
    try {
      const { sendSmsReminder } = await import("@/shared/lib/twilioSms");
      await sendSmsReminder(
        phone,
        `${salon}: A ${amount} deposit is required to confirm your appointment. Please pay here to hold your spot: ${url}`,
        { lang: "en" },
      );
    } catch (e) {
      console.error("[sendEscalationDepositLink] sms", e);
    }
  }
  const email = String(b.client_email ?? "").trim();
  if (email) {
    try {
      const { sendCustomerLinkEmail } = await import(
        "@/shared/lib/sendCustomerLinkEmail"
      );
      await sendCustomerLinkEmail({
        email,
        clientName: b.client_name ?? null,
        salonName: salon,
        salonAddress: null,
        lang: "en",
        subject: `Pay your ${amount} deposit to confirm · ${salon}`,
        bodyText: `A ${amount} deposit is required to confirm and hold your appointment.`,
        ctaLabel: `Pay ${amount} deposit`,
        url,
      });
    } catch (e) {
      console.error("[sendEscalationDepositLink] email", e);
    }
  }
}
