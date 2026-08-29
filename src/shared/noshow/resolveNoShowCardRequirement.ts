"use server";

import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { parseCardGateRules, cardRequiredByHistory } from "@/shared/noshow/cardGateRules";
import { resolvePaymentProvider } from "@/shared/integrations/payments";
import { getSquareConfig } from "@/shared/integrations/square/client";
import { v1AllowsNoShowCardOnFile } from "@/shared/release/v1IntegrationScope";
import { quotePublicBookingSequence } from "@/shared/booking/bookingSequenceServer";

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const str = (v: unknown): string => (v == null ? "" : String(v));
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  /** For a GROUP booking: ALL members' service ids (incl. the organizer). When
   *  whole-party protection is on, the displayed fee covers the whole group so
   *  it matches what the server saves on the organizer's card. */
  groupServiceIds?: string[];
  /** A sequence fee must be derived from a fresh authoritative quote, never
   *  from browser totals or de-duplicated catalog ids. Both fields are required
   *  together and the exact fingerprint must still match. */
  sequenceIntent?: unknown;
  sequencePricingFingerprint?: string;
}): Promise<NoShowCardRequirement> {
  // Product-level V1 boundary: do not make the browser wait on a database or
  // provider capability that cannot be used in this release. Keep this guard
  // ahead of every client construction/read as a second line of defense behind
  // the client-side gate.
  if (!v1AllowsNoShowCardOnFile()) return { required: false };

  try {
    const db = looseServiceClient();

    // Policy on the salon.
    const { data: salon } = await db
      .from("salons")
      .select("noshow_protection_enabled, noshow_fee_percent, noshow_group_whole_party, noshow_deposit_escalation_threshold, noshow_require_new_customer, noshow_require_prior_noshow, noshow_min_noshow_count, noshow_require_high_risk")
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
    const provider = await resolvePaymentProvider(args.salonId, { purpose: "card_on_file" });
    if (!provider || provider.kind !== "square") return { required: false };

    // Fee base: the whole party's services (group + whole-party on) or just this
    // service. Sum prices in one query so the gate stays fast.
    let priceCents: number;
    if (args.sequenceIntent != null || args.sequencePricingFingerprint != null) {
      if (
        args.sequenceIntent == null ||
        typeof args.sequencePricingFingerprint !== "string" ||
        !/^[0-9a-f]{64}$/.test(args.sequencePricingFingerprint)
      ) return { required: false };
      const sequenceQuote = await quotePublicBookingSequence(args.sequenceIntent);
      if (
        !sequenceQuote.ok ||
        sequenceQuote.quote.pricingFingerprint !== args.sequencePricingFingerprint
      ) return { required: false };
      // create_public_booking_sequence persists the sum of servicePriceCents as
      // bookings.price_cents; strict post-commit no-show policy uses that same
      // base. This keeps displayed consent and saved evidence cent-for-cent.
      priceCents = sequenceQuote.quote.lines.reduce(
        (sum, line) => sum + line.servicePriceCents,
        0,
      );
    } else {
      const requestedIds =
        wholeParty && args.groupServiceIds && args.groupServiceIds.length > 1
          ? args.groupServiceIds
          : [args.serviceId];
      if (
        requestedIds.length > 20 ||
        requestedIds.some((id) => typeof id !== "string" || !UUID_RE.test(id))
      ) {
        return { required: false };
      }
      const ids = Array.from(new Set(requestedIds));
      const { data: svcRows } = await db
        .from("services")
        .select("id, price_cents")
        .in("id", ids);
      const prices = new Map(
        ((svcRows as Row[] | null) ?? []).map((row) => [str(row.id), num(row.price_cents)]),
      );
      if (ids.some((id) => !prices.has(id))) return { required: false };
      priceCents = requestedIds.reduce(
        (sum, id) => sum + (prices.get(id) ?? 0),
        0,
      );
    }
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
    if (!cardRequiredByHistory({ isNew, noShowCount }, rules)) return { required: false };

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
