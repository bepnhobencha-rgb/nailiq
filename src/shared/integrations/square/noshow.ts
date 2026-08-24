/**
 * No-show fee via Square card-on-file (Option C).
 *
 * - saveNoShowCardForBooking: at booking time (risk-gated), save the customer's
 *   tokenized card on file (no charge) and stamp the booking with the card id +
 *   the fee that will be taken if they no-show.
 * - chargeNoShowFee: when a booking is marked no-show, charge the saved card for
 *   the stored fee. Idempotent — a booking already charged is a no-op.
 *
 * Unlike the deposit-via-PaymentLink path (immediate charge), nothing is charged
 * up front; the card is only billed on a confirmed no-show.
 */
import "server-only";
import { looseServiceClient, type Row } from "./looseDb";
import { parseCardGateRules, cardRequiredFull } from "@/shared/noshow/cardGateRules";
import { resolvePaymentProvider } from "@/shared/integrations/payments";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  createPaymentLink,
  getOrder,
  getSquareConfig,
} from "@/shared/integrations/square/client";
import { noShowPaymentReferenceId } from "./noshowPaymentReference";
import {
  runAuthoritativeBookingPaymentOperation,
  runAuthoritativeLateCancelRefund,
} from "@/shared/payments/executeBookingPaymentOperation";
import { stableBookingPaymentRequestId } from "@/shared/payments/paymentRequestId";
import { v1AllowsCustomerPaymentGateway } from "@/shared/release/v1IntegrationScope";

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type Db = ReturnType<typeof looseServiceClient>;

/** No-show policy is provider-agnostic now: it lives on `salons`, not on the
 *  Square integration. "Connected" (is a provider hooked up) is checked
 *  separately via resolvePaymentProvider, so a Stripe salon works too. */
async function loadPolicy(db: Db, salonId: string, strict = false) {
  const { data, error } = await db
    .from("salons")
    .select("noshow_protection_enabled, noshow_fee_percent, noshow_risk_threshold, noshow_group_whole_party, noshow_deposit_escalation_threshold, noshow_require_new_customer, noshow_require_prior_noshow, noshow_min_noshow_count, noshow_require_high_risk")
    .eq("id", salonId)
    .maybeSingle();
  if (strict && (error || !data)) throw new Error("noshow_policy_unavailable");
  const r = (data as Row) ?? {};
  return {
    enabled: Boolean(r.noshow_protection_enabled),
    percent: num(r.noshow_fee_percent) || 20,
    threshold: num(r.noshow_risk_threshold) || 60,
    // NULL/undefined → true (default-on whole-party protection).
    wholeParty: r.noshow_group_whole_party !== false,
    // Configurable "who is asked for a card" rules (default = legacy behavior).
    rules: parseCardGateRules(r),
    // NULL → escalation OFF (opt-in). Set (1..10) → that many prior no-shows
    // force an upfront pay-to-confirm deposit instead of card-on-file.
    escalationThreshold:
      r.noshow_deposit_escalation_threshold == null
        ? null
        : num(r.noshow_deposit_escalation_threshold),
  };
}

/**
 * The base amount the no-show % applies to. For a GROUP LEAD booking (the only
 * member with a card) when the salon uses whole-party protection, this is the
 * SUM of every member's service price — so the organizer's one card covers a
 * no-show fee for the whole party. Otherwise it's just this booking's own price.
 *
 * CANCELLED members are excluded: a guest who cancelled ahead of time gave
 * notice and was removed from the party, so charging the organizer for their
 * slot too would over-bill (e.g. 2 of 8 cancel early → the card must cover 6,
 * not the original 8). Members who NO-SHOW still count — they were expected and
 * didn't come, which is exactly what the fee protects against.
 */
async function noShowBaseCents(
  db: Db,
  booking: Row,
  wholeParty: boolean,
  strict = false,
): Promise<{ baseCents: number; partySize: number }> {
  const own = num(booking.price_cents);
  const groupId = str(booking.group_id);
  if (!wholeParty || !groupId) return { baseCents: own, partySize: 1 };
  const { data, error } = await db
    .from("bookings")
    .select("price_cents, status")
    .eq("salon_id", str(booking.salon_id))
    .eq("group_id", groupId);
  if (strict && error) throw new Error("noshow_group_pricing_unavailable");
  // Exclude cancelled members in JS (the loose Db query type has no .neq()).
  const rows = ((data as Row[] | null) ?? []).filter(
    (r) => str(r.status) !== "cancelled",
  );
  if (rows.length <= 1) return { baseCents: own, partySize: rows.length || 1 };
  const total = rows.reduce((sum, r) => sum + num(r.price_cents), 0);
  return { baseCents: total > 0 ? total : own, partySize: rows.length };
}

/**
 * Card-on-file SUPERSEDES a deposit. Once a no-show card is saved for a booking,
 * the customer is already protected, so drop any still-UNPAID deposit
 * requirement — otherwise the desk sees a phantom "deposit required" alongside
 * the saved card (double protection that confuses staff and double-asks the
 * customer). Guarded to `deposit_status='required'` so a genuinely PAID deposit
 * is never touched.
 */
/** Whether the salon has opted into Square deposits (square_integrations flag).
 *  Used to guard auto-escalation: only forfeit the card tier for a deposit when
 *  a deposit can actually be created. */
async function depositsEnabled(db: Db, salonId: string, strict = false): Promise<boolean> {
  const { data, error } = await db
    .from("square_integrations")
    .select("deposit_enabled")
    .eq("salon_id", salonId)
    .maybeSingle();
  if (strict && error) throw new Error("noshow_deposit_policy_unavailable");
  return (data as { deposit_enabled?: boolean } | null)?.deposit_enabled === true;
}

async function supersedeDepositWithCard(db: Db, bookingId: string): Promise<void> {
  await db
    .from("bookings")
    .update({ deposit_required: false, deposit_status: "not_required" } as never)
    .eq("id", bookingId)
    .eq("deposit_status", "required");
}

/** Whether this booking should be asked to leave a card (risk-gated). The
 *  public booking page calls this to decide whether to render the card step. */
export async function noShowCardDecision(
  bookingId: string,
  options?: { strict?: boolean },
): Promise<{ required: boolean; feeCents: number; reason: string; partySize?: number }> {
  const db = looseServiceClient();
  const { data, error } = await db
    .from("bookings")
    .select("salon_id, price_cents, no_show_risk_score, noshow_card_id, noshow_card_required, client_phone, group_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (options?.strict && (error || !data)) throw new Error("noshow_booking_unavailable");
  const b = data as Row | null;
  if (!b) return { required: false, feeCents: 0, reason: "booking not found" };
  if (b.noshow_card_id) return { required: false, feeCents: 0, reason: "card already saved" };

  const policy = await loadPolicy(db, str(b.salon_id), options?.strict === true);
  if (!policy.enabled) {
    return { required: false, feeCents: 0, reason: "no-show protection off" };
  }
  // Connection check is provider-agnostic: a usable Square OR Stripe provider.
  const provider = await resolvePaymentProvider(str(b.salon_id), { strict: options?.strict === true });
  if (!provider) {
    return { required: false, feeCents: 0, reason: "no payment provider connected" };
  }

  // Gate: a NEW customer (no prior non-cancelled booking at this salon) always
  // leaves a card; returning customers only when their no-show risk is high.
  // Loyal returning clients with a clean history are never asked (low friction).
  const risk = num(b.no_show_risk_score);
  const { isNew, hadNoShow, noShowCount } = await priorBookingStats(
    db, str(b.salon_id), str(b.client_phone), bookingId, options?.strict === true,
  );
  // Auto-escalation: a customer with ≥ threshold prior no-shows must pay an
  // UPFRONT deposit (handled by evaluateBookingNoShow), so we do NOT ask them
  // for a card — card-on-file is the low-friction tier they've forfeited.
  // GUARD: only skip the card when deposits are actually enabled; otherwise we'd
  // leave a high-risk customer with NO protection at all (worse than a card).
  if (
    policy.escalationThreshold != null &&
    noShowCount >= policy.escalationThreshold &&
    (await depositsEnabled(db, str(b.salon_id), options?.strict === true))
  ) {
    return { required: false, feeCents: 0, reason: "escalated to deposit" };
  }
  // A guarded live AI decision is persisted on the booking. Honour that
  // server-authored requirement even when the legacy history/risk gate would
  // not ask, while still deriving the amount solely from salon policy.
  if (b.noshow_card_required === true) {
    const { baseCents, partySize } = await noShowBaseCents(
      db,
      b,
      policy.wholeParty,
      options?.strict === true,
    );
    const feeCents = Math.round((baseCents * policy.percent) / 100);
    if (feeCents <= 0) {
      return { required: false, feeCents: 0, reason: "fee is zero" };
    }
    return {
      required: true,
      feeCents,
      reason: "booking policy requires card",
      partySize,
    };
  }
  const highRisk = risk >= policy.threshold;
  // Configurable gate (same pure helper the CLIENT pre-booking gate uses, plus
  // the server-only high-risk trigger). Server is always a superset of the
  // client, so a customer shown the card form is never rejected at save time.
  void hadNoShow; // superseded by rule-driven noShowCount check
  if (!cardRequiredFull({ isNew, noShowCount, highRisk }, policy.rules)) {
    return {
      required: false,
      feeCents: 0,
      reason: `not gated (risk ${risk} < ${policy.threshold})`,
    };
  }

  // Whole-party protection: for a group lead, the fee covers the entire party.
  const { baseCents, partySize } = await noShowBaseCents(
    db, b, policy.wholeParty, options?.strict === true,
  );
  const feeCents = Math.round((baseCents * policy.percent) / 100);
  if (feeCents <= 0) return { required: false, feeCents: 0, reason: "fee is zero" };
  return {
    required: true,
    feeCents,
    reason: isNew ? "new customer" : hadNoShow ? "prior no-show" : `risk ${risk} ≥ ${policy.threshold}`,
    partySize,
  };
}

/** Prior-booking signals for the no-show gate, in ONE query. `isNew` = no other
 *  non-cancelled booking at this salon for this phone. `hadNoShow` = at least one
 *  prior no_show. Empty/short phone → treated as new (safer to protect). */
async function priorBookingStats(
  db: Db,
  salonId: string,
  clientPhone: string,
  excludeBookingId: string,
  strict = false,
): Promise<{ isNew: boolean; hadNoShow: boolean; noShowCount: number }> {
  const phone = clientPhone.trim();
  if (phone.length < 8) return { isNew: true, hadNoShow: false, noShowCount: 0 };
  const { data, error } = await db
    .from("bookings")
    .select("status")
    .eq("salon_id", salonId)
    .eq("client_phone", phone)
    .not("id", "eq", excludeBookingId)
    .not("status", "eq", "cancelled")
    .limit(50);
  if (strict && error) throw new Error("noshow_history_unavailable");
  const rows = (data ?? []) as Row[];
  const noShowCount = rows.filter((r) => str(r.status) === "no_show").length;
  return {
    isNew: rows.length === 0,
    hadNoShow: noShowCount > 0,
    noShowCount,
  };
}

/** Save the customer's card on file for this booking (no charge). `consent` MUST
 *  be true — the customer has to agree to the no-show policy + card-on-file
 *  authorization before we may store/charge a card (legal + chargeback defense).
 *  The agreement time is stamped in `noshow_consent_at` and re-checked at charge. */
export async function saveNoShowCardForBooking(
  bookingId: string,
  sourceId: string,
  consent: boolean,
  verificationToken?: string,
): Promise<{ ok: boolean; reason: string; last4?: string }> {
  if (!consent) return { ok: false, reason: "consent required" };
  const db = looseServiceClient();
  const { data } = await db
    .from("bookings")
    .select("id, salon_id, client_name, client_phone, client_email, price_cents, noshow_card_id")
    .eq("id", bookingId)
    .maybeSingle();
  const b = data as Row | null;
  if (!b) return { ok: false, reason: "booking not found" };
  if (b.noshow_card_id) return { ok: true, reason: "already saved" }; // idempotent

  const decision = await noShowCardDecision(bookingId);
  if (!decision.required) return { ok: false, reason: decision.reason };

  const provider = await resolvePaymentProvider(str(b.salon_id));
  if (!provider) return { ok: false, reason: "payment provider not configured" };
  const saved = await provider.saveCardOnFile({
    customer: {
      name: str(b.client_name) || null,
      phone: str(b.client_phone) || null,
      email: str(b.client_email) || null,
      referenceId: `booking:${bookingId}`,
    },
    sourceToken: sourceId,
    verificationToken,
    // Legacy server-only callers retain stable provider dedupe while public
    // card capture migrates to the durable card_manage operation contract.
    idempotencyKey: `legacy-card-save:${bookingId}`,
  });

  // Server-authored consent evidence: the exact terms the customer agreed to,
  // captured at save time (amount + currency + plain-English policy). Stored as
  // proof for a chargeback dispute — never trust the client to supply this.
  const { data: salonRow } = await db
    .from("salons")
    .select("currency_code, name, cancellation_policy")
    .eq("id", str(b.salon_id))
    .maybeSingle();
  const sr = salonRow as Row | null;
  const currency = String(sr?.currency_code || "USD").trim().toUpperCase() || "USD";
  const feeStr = `${(decision.feeCents / 100).toFixed(2)} ${currency}`;
  // When the organizer's card covers a whole party, say so explicitly in the
  // consent — the fee is for the group, not one person (chargeback evidence).
  const partyClause =
    (decision.partySize ?? 1) > 1
      ? ` for their party of ${decision.partySize}`
      : "";
  const { policyEvidence } = await import("@/shared/lib/cancellationPolicy");
  const consentMeta = {
    policyText: `Cardholder authorized this salon to keep this card on file and to charge a no-show fee of ${feeStr}${partyClause} only if they do not show up for this appointment. No charge is made at booking. The cardholder may remove the card at any time.`,
    feeCents: decision.feeCents,
    currency,
    cardBrand: saved.brand,
    cardLast4: saved.last4,
    // Snapshot of the salon's full cancellation policy the customer agreed to —
    // strongest chargeback/consent evidence.
    cancellationPolicy: policyEvidence(
      sr?.cancellation_policy as { en?: string; vi?: string } | null,
      String(sr?.name || ""),
    ),
    capturedAt: new Date().toISOString(),
  };

  await db
    .from("bookings")
    .update({
      noshow_card_id: saved.cardId,
      noshow_customer_id: saved.customerId,
      noshow_card_last4: saved.last4,
      noshow_card_brand: saved.brand,
      noshow_fee_cents: decision.feeCents,
      noshow_charge_status: "saved",
      noshow_consent_at: new Date().toISOString(),
      noshow_consent_meta: consentMeta,
    } as never)
    .eq("id", bookingId);

  await supersedeDepositWithCard(db, bookingId);

  return { ok: true, reason: "saved", last4: saved.last4 };
}

/** Attach a returning customer's EXISTING saved card to this booking — no new
 *  card entry. Server-authoritative + OTP-gated: we re-validate the OTP session,
 *  take the phone FROM the session (never the client), look up the Square
 *  customer + their card ourselves, and stamp it on the booking. The client
 *  never supplies a card id, so it can't point us at someone else's card. */
export async function reuseNoShowCardForBooking(
  bookingId: string,
  otpSessionId: string,
  consent: boolean,
): Promise<{ ok: boolean; reason: string; last4?: string }> {
  if (!consent) return { ok: false, reason: "consent required" };
  if (!otpSessionId) return { ok: false, reason: "otp required" };

  const db = looseServiceClient();
  const { data } = await db
    .from("bookings")
    .select("id, salon_id, client_phone, noshow_card_id")
    .eq("id", bookingId)
    .maybeSingle();
  const b = data as Row | null;
  if (!b) return { ok: false, reason: "booking not found" };
  if (b.noshow_card_id) return { ok: true, reason: "already saved" }; // idempotent

  const decision = await noShowCardDecision(bookingId);
  if (!decision.required) return { ok: false, reason: decision.reason };

  // OTP gate: session must exist, match THIS salon, be unconsumed + unexpired,
  // and its verified phone must equal the booking's phone.
  const sb = createServiceRoleClient();
  const { data: sessRow } = await sb
    .from("phone_otp_sessions" as never)
    .select("phone, salon_id, expires_at, consumed_at")
    .eq("id", otpSessionId)
    .maybeSingle();
  const sess = sessRow as
    | { phone: string; salon_id: string; expires_at: string; consumed_at: string | null }
    | null;
  if (!sess) return { ok: false, reason: "otp invalid" };
  if (sess.salon_id !== str(b.salon_id)) return { ok: false, reason: "otp salon mismatch" };
  if (sess.consumed_at) return { ok: false, reason: "otp consumed" };
  if (Date.parse(sess.expires_at) < Date.now()) return { ok: false, reason: "otp expired" };
  const sessionPhone = (sess.phone || "").replace(/\D/g, "");
  const bookingPhone = str(b.client_phone).replace(/\D/g, "");
  if (!sessionPhone || sessionPhone !== bookingPhone) {
    return { ok: false, reason: "otp phone mismatch" };
  }

  // Provider-agnostic: re-derive the saved card from the OTP-verified phone.
  const provider = await resolvePaymentProvider(str(b.salon_id));
  if (!provider) return { ok: false, reason: "payment provider not configured" };
  const card = await provider.findSavedCardByPhone(sessionPhone);
  if (!card || !card.cardId) return { ok: false, reason: "no saved card" };
  const customerId = card.customerId;

  // Server-authored consent evidence (mirrors the save path) + a reused flag.
  const { data: salonRow } = await db
    .from("salons")
    .select("currency_code")
    .eq("id", str(b.salon_id))
    .maybeSingle();
  const currency = String((salonRow as Row | null)?.currency_code || "USD").trim().toUpperCase() || "USD";
  const feeStr = `${(decision.feeCents / 100).toFixed(2)} ${currency}`;
  const consentMeta = {
    policyText: `Cardholder authorized this salon to charge a no-show fee of ${feeStr} to their card on file (${card.brand} ending ${card.last4}) only if they do not show up for this appointment. No charge is made at booking. The cardholder may remove the card at any time.`,
    feeCents: decision.feeCents,
    currency,
    cardBrand: card.brand,
    cardLast4: card.last4,
    reused: true,
    capturedAt: new Date().toISOString(),
  };

  await db
    .from("bookings")
    .update({
      noshow_card_id: card.cardId,
      noshow_customer_id: customerId,
      noshow_card_last4: card.last4,
      noshow_card_brand: card.brand,
      noshow_fee_cents: decision.feeCents,
      noshow_charge_status: "saved",
      noshow_consent_at: new Date().toISOString(),
      noshow_consent_meta: consentMeta,
    } as never)
    .eq("id", bookingId);

  await supersedeDepositWithCard(db, bookingId);

  return { ok: true, reason: "reused", last4: card.last4 };
}

/**
 * Carry a returning customer's existing card-on-file FORWARD onto a fresh
 * booking — automatically, no re-entry and no OTP. The no-show card is stored
 * per-booking (`noshow_card_id`), so without this a customer who left a card on
 * visit #1 had NO card on visit #2 (returning + clean → never re-asked), leaving
 * every repeat visit unprotected. This closes that gap with zero added friction.
 *
 * Server-authoritative + safe by construction:
 *  - the phone comes from the BOOKING row (salon-trusted: OTP-verified online /
 *    receptionist-entered at the desk), never from the client;
 *  - we look up the saved card via the provider ourselves (the client never
 *    supplies a card id, so it can't point us at someone else's card);
 *  - nothing is charged here — the card only bills on a confirmed no-show, and
 *    that fee is paid to the salon, so attaching a card has no abuse value.
 *
 * Idempotent + best-effort: a booking that already has a card is a no-op; a new
 * customer (no card on file) is skipped so the normal "new customer must leave a
 * card" capture still runs. Never throws.
 *
 * NOTE: unlike `noShowCardDecision`, this is intentionally INDEPENDENT of the
 * required-gate — a loyal, clean returning customer returns `required: false`,
 * yet we DO want their already-authorized card to keep protecting them.
 */
export async function autoAttachReturningCard(
  bookingId: string,
): Promise<{ attached: boolean; reason: string; last4?: string }> {
  try {
    const db = looseServiceClient();
    const { data } = await db
      .from("bookings")
      .select("id, salon_id, price_cents, client_phone, noshow_card_id, group_id, deposit_required, deposit_status")
      .eq("id", bookingId)
      .maybeSingle();
    const b = data as Row | null;
    if (!b) return { attached: false, reason: "booking not found" };
    if (b.noshow_card_id) {
      await db
        .from("bookings")
        .update({ noshow_card_required: false } as never)
        .eq("id", bookingId);
      return { attached: true, reason: "already saved" };
    }
    const depositStatus = str(b.deposit_status);
    const hasActiveDeposit =
      ["required", "pending", "held", "paid"].includes(depositStatus) ||
      (b.deposit_required === true && !depositStatus);
    if (hasActiveDeposit) {
      return { attached: false, reason: "deposit already protects booking" };
    }

    const phone = str(b.client_phone).replace(/\D/g, "");
    if (phone.length < 8) return { attached: false, reason: "no usable phone" };

    const policy = await loadPolicy(db, str(b.salon_id));
    if (!policy.enabled) return { attached: false, reason: "no-show protection off" };

    const provider = await resolvePaymentProvider(str(b.salon_id));
    if (!provider) return { attached: false, reason: "no payment provider connected" };

    // Only CARRY FORWARD a card the customer already authorized — never enroll a
    // new card here. No saved card → leave it to the new-customer capture flow.
    const card = await provider.findSavedCardByPhone(phone);
    if (!card || !card.cardId) return { attached: false, reason: "no saved card on file" };

    // Whole-party: a returning organizer's carried-forward card also covers the
    // group total (keeps it consistent with the new-card path).
    const { baseCents } = await noShowBaseCents(db, b, policy.wholeParty);
    const feeCents = Math.round((baseCents * policy.percent) / 100);
    if (feeCents <= 0) return { attached: false, reason: "fee is zero" };

    const { data: salonRow } = await db
      .from("salons")
      .select("currency_code, name, cancellation_policy")
      .eq("id", str(b.salon_id))
      .maybeSingle();
    const sr = salonRow as Row | null;
    const currency =
      String(sr?.currency_code || "USD").trim().toUpperCase() || "USD";
    const feeStr = `${(feeCents / 100).toFixed(2)} ${currency}`;
    const { policyEvidence } = await import("@/shared/lib/cancellationPolicy");
    const consentMeta = {
      policyText: `Cardholder previously authorized this salon to keep this card (${card.brand} ending ${card.last4}) on file for their visits, and to charge a no-show fee of ${feeStr} only if they do not show up. The card on file is carried forward to this appointment. No charge is made at booking. The cardholder may remove the card at any time.`,
      feeCents,
      currency,
      cardBrand: card.brand,
      cardLast4: card.last4,
      reused: true,
      carriedForward: true,
      capturedAt: new Date().toISOString(),
      cancellationPolicy: policyEvidence(
        sr?.cancellation_policy as { en?: string; vi?: string } | null,
        String(sr?.name || ""),
      ),
    };

    await db
      .from("bookings")
      .update({
        noshow_card_id: card.cardId,
        noshow_customer_id: card.customerId,
        noshow_card_last4: card.last4,
        noshow_card_brand: card.brand,
        noshow_fee_cents: feeCents,
        noshow_charge_status: "saved",
        noshow_consent_at: new Date().toISOString(),
        noshow_consent_meta: consentMeta,
        noshow_card_required: false,
      } as never)
      .eq("id", bookingId);

    await supersedeDepositWithCard(db, bookingId);

    return { attached: true, reason: "carried forward", last4: card.last4 };
  } catch (e) {
    console.error("[autoAttachReturningCard]", e);
    return { attached: false, reason: "error" };
  }
}

/** Charge the saved card for the no-show fee. Called when a booking is marked
 *  no-show. Idempotent and safe to call on bookings without a saved card. */
export async function chargeNoShowFee(
  bookingId: string,
  opts?: {
    /** Payment note/descriptor. Defaults to "No-show fee"; the late-cancel path
     *  passes "Late cancellation fee" so the customer's statement is accurate. */
    note?: string;
    amountCentsOverride?: number;
    /** Late cancellation is a separate DB-owned cancel occurrence. It must
     * never be recorded as a no-show or share that lifetime charge identity. */
    operationKind?: "noshow_charge" | "late_cancel_charge";
    /** Required immutable version from the committed cancel receipt. Never
     * infer a late-cancel occurrence from a later mutable booking row. */
    occurrenceVersion?: number;
  },
): Promise<{
  charged: boolean;
  status: "succeeded" | "pending_provider" | "unknown" | "definite_failure" | "not_applicable";
  reason: string;
  paymentId?: string;
}> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("bookings")
    .select("id, salon_id")
    .eq("id", bookingId)
    .maybeSingle();
  const booking = data as {
    id?: string;
    salon_id?: string;
  } | null;
  if (error || !booking?.id || !booking.salon_id) {
    return { charged: false, status: "not_applicable", reason: "payment_context_unavailable" };
  }
  const operationKind = opts?.operationKind ?? "noshow_charge";
  const occurrence = operationKind === "late_cancel_charge"
    ? Number.isSafeInteger(opts?.occurrenceVersion) && Number(opts?.occurrenceVersion) > 0
      ? String(opts?.occurrenceVersion)
      : null
    : "lifetime";
  if (!occurrence) {
    return { charged: false, status: "not_applicable", reason: "late_cancel_occurrence_required" };
  }
  const outcome = await runAuthoritativeBookingPaymentOperation({
    db: db as never,
    salonId: booking.salon_id,
    bookingId,
    requestId: stableBookingPaymentRequestId(bookingId, operationKind, occurrence),
    operationKind,
    amountCents: opts?.amountCentsOverride ?? null,
    note: opts?.note ?? (operationKind === "late_cancel_charge"
      ? "Late cancellation fee"
      : "No-show fee"),
    referenceId: noShowPaymentReferenceId(bookingId),
  });
  return outcome.ok
    ? {
      charged: true,
        status: "succeeded",
        reason: "succeeded",
        paymentId: outcome.providerReceipt,
      }
    : {
      charged: false,
        status: outcome.status === "pending_provider"
          ? "pending_provider"
          : outcome.status === "unknown"
            ? "unknown"
            : outcome.status === "definite_failure"
              ? "definite_failure"
              : "not_applicable",
        reason: outcome.reason,
      };
}

/**
 * Refund a charged no-show fee through the authoritative ledger. The shared
 * executor performs load_booking_payment_operation_material →
 * claim_booking_payment_operation → complete_booking_payment_operation.
 * Late-cancel refunds deliberately use the parent-bound Fair Cancel path below.
 */
export async function refundNoShowFee(
  bookingId: string,
  opts?: { reason?: string; amountCents?: number; requestId?: string },
): Promise<{ refunded: boolean; reason: string }> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("bookings")
    .select("id, salon_id, noshow_fee_cents, noshow_refunded_cents")
    .eq("id", bookingId)
    .maybeSingle();
  const b = data as Row | null;
  if (error || !b || !str(b.salon_id)) {
    return { refunded: false, reason: "payment_context_unavailable" };
  }
  const remaining = Math.max(0, num(b.noshow_fee_cents) - num(b.noshow_refunded_cents));
  const amount = opts?.amountCents ?? remaining;
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { refunded: false, reason: "no_refundable_amount" };
  }
  const requestId = opts?.requestId ?? stableBookingPaymentRequestId(
    bookingId,
    "noshow_refund",
    `refund:${amount}`,
  );
  const outcome = await runAuthoritativeBookingPaymentOperation({
    db: db as never,
    salonId: str(b.salon_id),
    bookingId,
    requestId,
    operationKind: "noshow_refund",
    amountCents: amount,
    reason: opts?.reason ?? "No-show fee refund",
  });
  return outcome.ok
    ? { refunded: true, reason: "succeeded" }
    : { refunded: false, reason: outcome.reason };
}

/**
 * Fair Cancel: auto-refund late-cancellation fees whose freed slot has since
 * been re-booked (by the waitlist auto-book OR any organic booking that grabbed
 * the same slot) before the original appointment time — the salon lost nothing,
 * so the customer shouldn't pay. Runs from the waitlist-advance cron (~5 min).
 *
 * Refill detection is slot-shaped (salon_id + staff_id + start_time_utc), which
 * catches every re-book path without touching the booking-create RPCs. Only
 * considers future-start slots: once the appointment time passes, the fee is
 * final whether or not the slot was ever filled.
 */
export async function refundRefilledLateCancels(): Promise<{
  checked: number;
  refunded: number;
}> {
  // Dedicated contract: load_late_cancel_refund_material →
  // claim_late_cancel_refund → dispatchClaimedBookingPaymentOperation.
  const db = looseServiceClient();
  const nowIso = new Date().toISOString();
  const { data } = await db
    .from("bookings")
    .select("id, salon_id, staff_id, start_time_utc, end_time_utc")
    .eq("status", "cancelled")
    .eq("noshow_charge_status", "charged")
    .not("noshow_payment_id", "is", null)
    .not("staff_id", "is", null)
    .gt("start_time_utc", nowIso)
    .limit(200);

  const candidates = (data ?? []) as Array<{
    id: string;
    salon_id: string;
    staff_id: string | null;
    start_time_utc: string | null;
  }>;

  let refunded = 0;
  for (const c of candidates) {
    if (!c.staff_id || !c.start_time_utc) continue;
    // Is the exact freed slot now held by another active booking?
    const { data: refill, error: refillError } = await db
      .from("bookings")
      .select("id")
      .eq("salon_id", c.salon_id)
      .eq("staff_id", c.staff_id)
      .eq("start_time_utc", c.start_time_utc)
      .in("status", ["pending", "confirmed"])
      .limit(3);
    if (refillError) continue;
    const refillRows = (refill as Array<{ id: string }> | null) ?? [];
    const isRefilled = refillRows.some((r) => r.id !== c.id);
    if (isRefilled) {
      const { data: parent, error: parentError } = await db
        .from("booking_payment_operations")
        .select("id, amount_cents")
        .eq("salon_id", c.salon_id)
        .eq("booking_id", c.id)
        .eq("operation_kind", "late_cancel_charge")
        .eq("status", "succeeded")
        .order("completed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const parentRow = parent as { id?: string; amount_cents?: number } | null;
      if (parentError || !parentRow?.id || !Number.isSafeInteger(parentRow.amount_cents)) {
        continue;
      }
      const result = await runAuthoritativeLateCancelRefund({
        db: db as never,
        parentOperationId: parentRow.id,
        requestId: stableBookingPaymentRequestId(
          c.id,
          "late_cancel_refund",
          parentRow.id,
        ),
        amountCents: Number(parentRow.amount_cents),
        reason: "Late cancellation fee refunded — slot rebooked",
      });
      if (result.ok) refunded += 1;
    }
  }
  return { checked: candidates.length, refunded };
}

/**
 * Create a Square hosted payment link so the CUSTOMER can pay their own no-show
 * fee — the recovery path for a card that just won't charge (closed / chronic
 * insufficient funds). Idempotent: reuses an existing link. The link's order id
 * is stored on the booking; reconcileNoShowFeeLinks flips the fee to 'charged'
 * once the customer pays. Square-only (payment links are a Square feature).
 */
export async function createNoShowFeeLink(
  bookingId: string,
): Promise<{ ok: boolean; url?: string; amountCents?: number; reason?: string }> {
  if (!v1AllowsCustomerPaymentGateway()) {
    return { ok: false, reason: "phase_2_not_available" };
  }
  const db = looseServiceClient();
  const { data } = await db
    .from("bookings")
    .select(
      "id, salon_id, noshow_fee_cents, noshow_charge_status, noshow_fee_link_url",
    )
    .eq("id", bookingId)
    .maybeSingle();
  const b = data as Row | null;
  if (!b) return { ok: false, reason: "booking not found" };
  if (b.noshow_charge_status === "charged")
    return { ok: false, reason: "already charged" };
  const feeCents = num(b.noshow_fee_cents);
  if (feeCents <= 0) return { ok: false, reason: "fee is zero" };
  // Idempotent — reuse the existing link rather than minting a second one.
  if (b.noshow_fee_link_url)
    return { ok: true, url: str(b.noshow_fee_link_url), amountCents: feeCents };

  const cfg = await getSquareConfig(db, str(b.salon_id));
  const link = await createPaymentLink(cfg, {
    amountCents: feeCents,
    name: "No-show fee",
    // Short ref (Square caps description); the stored order id is the reconcile
    // key, so the ref needn't encode the booking id.
    referenceId: "no-show-fee",
    idempotencyKey: `nsf:${bookingId}`,
    note: "No-show fee",
  });
  await db
    .from("bookings")
    .update({
      noshow_fee_link_url: link.url,
      noshow_fee_order_id: link.orderId,
    } as never)
    .eq("id", bookingId);
  return { ok: true, url: link.url, amountCents: feeCents };
}

/**
 * Mark a no-show fee as collected once the customer pays its hosted link.
 * Mirrors reconcileDeposits — called per-salon from the square-sync cron.
 */
export async function reconcileNoShowFeeLinks(
  salonId: string,
): Promise<{ ok: boolean; checked: number; paid: number; error?: string }> {
  if (!v1AllowsCustomerPaymentGateway()) {
    return { ok: false, checked: 0, paid: 0, error: "phase_2_not_available" };
  }
  if (!UUID_RE.test(salonId)) {
    return {
      ok: false,
      checked: 0,
      paid: 0,
      error: "square_noshow_reconciliation_input_invalid",
    };
  }
  const db = looseServiceClient();
  const { data, error } = await db
    .from("bookings")
    .select("id, noshow_fee_cents, noshow_fee_order_id, noshow_charge_status")
    .eq("salon_id", salonId)
    .not("noshow_fee_order_id", "is", null)
    .not("noshow_charge_status", "eq", "charged");
  if (error || !Array.isArray(data)) {
    return {
      ok: false,
      checked: 0,
      paid: 0,
      error: "square_noshow_reconciliation_inventory_unavailable",
    };
  }
  const rows = data as Row[];
  if (rows.length === 0) return { ok: true, checked: 0, paid: 0 };

  let cfg: Awaited<ReturnType<typeof getSquareConfig>>;
  try {
    cfg = await getSquareConfig(db, salonId);
  } catch {
    return {
      ok: false,
      checked: rows.length,
      paid: 0,
      error: "square_noshow_reconciliation_config_unavailable",
    };
  }
  let paid = 0;
  for (const r of rows) {
    const bookingId = str(r.id);
    const orderId = str(r.noshow_fee_order_id);
    const feeCents = num(r.noshow_fee_cents);
    if (
      !UUID_RE.test(bookingId)
      || !orderId
      || orderId.length > 255
      || !Number.isSafeInteger(feeCents)
      || feeCents <= 0
    ) {
      return {
        ok: false,
        checked: rows.length,
        paid,
        error: "square_noshow_reconciliation_inventory_invalid",
      };
    }
    try {
      const order = await getOrder(cfg, orderId);
      const state = order.state.trim().toUpperCase();
      if (
        !state
        || !Number.isSafeInteger(order.paidCents)
        || order.paidCents < 0
        || (order.tenderPaymentId !== null && typeof order.tenderPaymentId !== "string")
      ) {
        return {
          ok: false,
          checked: rows.length,
          paid,
          error: "square_noshow_reconciliation_provider_response_invalid",
        };
      }
      if (state === "COMPLETED") {
        if (order.paidCents < feeCents || !order.tenderPaymentId) {
          return {
            ok: false,
            checked: rows.length,
            paid,
            error: "square_noshow_reconciliation_provider_receipt_invalid",
          };
        }
        const update = await db
          .from("bookings")
          .update({
            noshow_charge_status: "charged",
            noshow_payment_id: order.tenderPaymentId,
          } as never)
          .eq("id", bookingId)
          .eq("salon_id", salonId)
          .select("id")
          .maybeSingle();
        if (update.error || str(update.data?.id) !== bookingId) {
          return {
            ok: false,
            checked: rows.length,
            paid,
            error: "square_noshow_reconciliation_write_unavailable",
          };
        }
        paid++;
        continue;
      }
      if (["OPEN", "PENDING", "APPROVED"].includes(state)) continue;
      if (["CANCELED", "CANCELLED", "FAILED", "REJECTED"].includes(state)) {
        return {
          ok: false,
          checked: rows.length,
          paid,
          error: "square_noshow_reconciliation_provider_rejected",
        };
      }
      return {
        ok: false,
        checked: rows.length,
        paid,
        error: "square_noshow_reconciliation_provider_response_invalid",
      };
    } catch {
      return {
        ok: false,
        checked: rows.length,
        paid,
        error: "square_noshow_reconciliation_provider_unavailable",
      };
    }
  }
  return { ok: true, checked: rows.length, paid };
}
