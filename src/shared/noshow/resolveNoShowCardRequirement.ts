"use server";

import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import {
  parseCardGateRules,
  cardRequiredByHistory,
  isShortNoticeAppointment,
} from "@/shared/noshow/cardGateRules";
import { resolvePaymentProvider } from "@/shared/integrations/payments";
import { getSquareConfig } from "@/shared/integrations/square/client";

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const str = (v: unknown): string => (v == null ? "" : String(v));

export type NoShowCardRequirement =
  | { required: false }
  | {
      required: true;
      feeCents: number;
      provider: "square";
      applicationId: string;
      locationId: string;
      environment: "production" | "sandbox";
    };

/**
 * Decide — BEFORE the booking row exists — whether this customer must leave a
 * card to confirm (new customer, or one with a prior no-show), for a salon with
 * no-show protection + a connected provider + a non-zero fee. Powers the
 * card-gate INSIDE the confirm step (Option A): no booking is created and no
 * SMS/email is sent until the card is captured.
 *
 * Deterministic + fast (no AI call): new customer OR previous no-show. The full
 * AI risk score is still computed post-booking for the dashboard (unchanged).
 *
 * Square only for now (Hi-Lite's provider). Stripe wallets are Đợt 2 (dormant
 * until Connect) and keep the post-booking path.
 */
export async function resolveNoShowCardRequirement(args: {
  salonId: string;
  serviceId: string;
  clientPhone: string;
  /** Selected appointment start, derived from the salon-local slot. Required
   *  for the optional short-notice card rule; omitted preserves legacy rules. */
  appointmentStartUtc?: string | null;
  /** For a GROUP booking: ALL members' service ids (incl. the organizer). When
   *  whole-party protection is on, the displayed fee covers the whole group so
   *  it matches what the server saves on the organizer's card. */
  groupServiceIds?: string[];
}): Promise<NoShowCardRequirement> {
  try {
    const db = looseServiceClient();

    // Policy on the salon.
    const { data: salon } = await db
      .from("salons")
      .select("noshow_protection_enabled, noshow_fee_percent, noshow_group_whole_party, noshow_deposit_escalation_threshold, noshow_require_new_customer, noshow_require_prior_noshow, noshow_min_noshow_count, noshow_require_high_risk, noshow_short_notice_hours")
      .eq("id", args.salonId)
      .maybeSingle();
    const s = (salon ?? {}) as Row;
    if (!s.noshow_protection_enabled) return { required: false };
    const percent = num(s.noshow_fee_percent) || 20;
    const rules = parseCardGateRules(s);
    const wholeParty = s.noshow_group_whole_party !== false;
    const escalationThreshold =
      s.noshow_deposit_escalation_threshold == null
        ? null
        : num(s.noshow_deposit_escalation_threshold);

    // Provider must be connected; Square-only gate for the pre-booking flow.
    const provider = await resolvePaymentProvider(args.salonId);
    if (!provider || provider.kind !== "square") return { required: false };

    // Fee base: the whole party's services (group + whole-party on) or just this
    // service. Sum prices in one query so the gate stays fast.
    const ids =
      wholeParty && args.groupServiceIds && args.groupServiceIds.length > 1
        ? Array.from(new Set(args.groupServiceIds))
        : [args.serviceId];
    const { data: svcRows } = await db
      .from("services")
      .select("price_cents")
      .in("id", ids);
    const priceCents = ((svcRows as Row[] | null) ?? []).reduce(
      (sum, r) => sum + num(r.price_cents),
      0,
    );
    const feeCents = Math.round((priceCents * percent) / 100);
    if (feeCents <= 0) return { required: false };

    // Gate: new customer (no prior non-cancelled booking at this salon) OR a
    // customer with a prior no-show.
    const phone = args.clientPhone.replace(/\D/g, "");
    let isNew = true;
    let hadNoShow = false;
    let noShowCount = 0;
    if (phone.length >= 8) {
      const { data: prior } = await db
        .from("bookings")
        .select("status")
        .eq("salon_id", args.salonId)
        .eq("client_phone", phone)
        .not("status", "eq", "cancelled")
        .limit(50);
      const rows = (prior ?? []) as Row[];
      isNew = rows.length === 0;
      noShowCount = rows.filter((r) => str(r.status) === "no_show").length;
      hadNoShow = noShowCount > 0;
    }
    // Auto-escalation: a customer with ≥ threshold prior no-shows is routed to a
    // pay-to-confirm DEPOSIT (enforced server-side after creation), not a card —
    // so don't show them the card step. GUARD: only skip the card when deposits
    // are enabled, else a high-risk customer would end up with NO protection.
    if (escalationThreshold != null && noShowCount >= escalationThreshold) {
      const { data: sq } = await db
        .from("square_integrations")
        .select("deposit_enabled")
        .eq("salon_id", args.salonId)
        .maybeSingle();
      if ((sq as Row | null)?.deposit_enabled === true) {
        return { required: false };
      }
    }
    void hadNoShow; // superseded by the configurable rule check below
    const shortNotice = isShortNoticeAppointment(
      args.appointmentStartUtc,
      rules.shortNoticeHours,
    );
    if (!shortNotice && !cardRequiredByHistory({ isNew, noShowCount }, rules)) {
      return { required: false };
    }

    // Public Web Payments SDK params.
    const cfg = await getSquareConfig(db, args.salonId);
    if (!cfg.applicationId) return { required: false };

    return {
      required: true,
      feeCents,
      provider: "square",
      applicationId: cfg.applicationId,
      locationId: cfg.locationId,
      environment: cfg.environment,
    };
  } catch (e) {
    console.error("[resolveNoShowCardRequirement]", e);
    return { required: false }; // fail-open: never block a booking on this check
  }
}
