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
import { resolvePaymentProvider } from "@/shared/integrations/payments";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  createPaymentLink,
  getOrder,
  getSquareConfig,
} from "@/shared/integrations/square/client";

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => (v == null ? 0 : Number(v));

type Db = ReturnType<typeof looseServiceClient>;

/** No-show policy is provider-agnostic now: it lives on `salons`, not on the
 *  Square integration. "Connected" (is a provider hooked up) is checked
 *  separately via resolvePaymentProvider, so a Stripe salon works too. */
async function loadPolicy(db: Db, salonId: string) {
  const { data } = await db
    .from("salons")
    .select("noshow_protection_enabled, noshow_fee_percent, noshow_risk_threshold")
    .eq("id", salonId)
    .maybeSingle();
  const r = (data as Row) ?? {};
  return {
    enabled: Boolean(r.noshow_protection_enabled),
    percent: num(r.noshow_fee_percent) || 20,
    threshold: num(r.noshow_risk_threshold) || 60,
  };
}

/**
 * Card-on-file SUPERSEDES a deposit. Once a no-show card is saved for a booking,
 * the customer is already protected, so drop any still-UNPAID deposit
 * requirement — otherwise the desk sees a phantom "deposit required" alongside
 * the saved card (double protection that confuses staff and double-asks the
 * customer). Guarded to `deposit_status='required'` so a genuinely PAID deposit
 * is never touched.
 */
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
): Promise<{ required: boolean; feeCents: number; reason: string }> {
  const db = looseServiceClient();
  const { data } = await db
    .from("bookings")
    .select("salon_id, price_cents, no_show_risk_score, noshow_card_id, client_phone")
    .eq("id", bookingId)
    .maybeSingle();
  const b = data as Row | null;
  if (!b) return { required: false, feeCents: 0, reason: "booking not found" };
  if (b.noshow_card_id) return { required: false, feeCents: 0, reason: "card already saved" };

  const policy = await loadPolicy(db, str(b.salon_id));
  if (!policy.enabled) {
    return { required: false, feeCents: 0, reason: "no-show protection off" };
  }
  // Connection check is provider-agnostic: a usable Square OR Stripe provider.
  const provider = await resolvePaymentProvider(str(b.salon_id));
  if (!provider) {
    return { required: false, feeCents: 0, reason: "no payment provider connected" };
  }

  // Gate: a NEW customer (no prior non-cancelled booking at this salon) always
  // leaves a card; returning customers only when their no-show risk is high.
  // Loyal returning clients with a clean history are never asked (low friction).
  const risk = num(b.no_show_risk_score);
  const { isNew, hadNoShow } = await priorBookingStats(
    db, str(b.salon_id), str(b.client_phone), bookingId,
  );
  const highRisk = risk >= policy.threshold;
  // Must require a card whenever the CLIENT pre-booking gate
  // (resolveNoShowCardRequirement) does — new OR prior no-show — PLUS the
  // server-only high-risk trigger. If the server required LESS than the client,
  // a customer who was shown the card form would have their booking cancelled
  // at save time (the two gates must not diverge).
  if (!isNew && !highRisk && !hadNoShow) {
    return {
      required: false,
      feeCents: 0,
      reason: `returning, clean, risk ${risk} < ${policy.threshold}`,
    };
  }

  const feeCents = Math.round((num(b.price_cents) * policy.percent) / 100);
  if (feeCents <= 0) return { required: false, feeCents: 0, reason: "fee is zero" };
  return {
    required: true,
    feeCents,
    reason: isNew ? "new customer" : hadNoShow ? "prior no-show" : `risk ${risk} ≥ ${policy.threshold}`,
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
): Promise<{ isNew: boolean; hadNoShow: boolean }> {
  const phone = clientPhone.trim();
  if (phone.length < 8) return { isNew: true, hadNoShow: false };
  const { data } = await db
    .from("bookings")
    .select("status")
    .eq("salon_id", salonId)
    .eq("client_phone", phone)
    .not("id", "eq", excludeBookingId)
    .not("status", "eq", "cancelled")
    .limit(50);
  const rows = (data ?? []) as Row[];
  return {
    isNew: rows.length === 0,
    hadNoShow: rows.some((r) => str(r.status) === "no_show"),
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
  const { policyEvidence } = await import("@/shared/lib/cancellationPolicy");
  const consentMeta = {
    policyText: `Cardholder authorized this salon to keep this card on file and to charge a no-show fee of ${feeStr} only if they do not show up for this appointment. No charge is made at booking. The cardholder may remove the card at any time.`,
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
      .select("id, salon_id, price_cents, client_phone, noshow_card_id")
      .eq("id", bookingId)
      .maybeSingle();
    const b = data as Row | null;
    if (!b) return { attached: false, reason: "booking not found" };
    if (b.noshow_card_id) return { attached: true, reason: "already saved" };

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

    const feeCents = Math.round((num(b.price_cents) * policy.percent) / 100);
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
    /** Appended to the idempotency key. The first charge uses the stable key
     *  (double-charge-safe on a network retry). A deliberate RETRY of a failed
     *  charge must pass a fresh suffix, else Square dedups the key and just
     *  replays the original decline instead of re-attempting. */
    idempotencySuffix?: string;
  },
): Promise<{ charged: boolean; reason: string; paymentId?: string }> {
  const db = looseServiceClient();
  const { data } = await db
    .from("bookings")
    .select("id, salon_id, noshow_card_id, noshow_customer_id, noshow_fee_cents, noshow_charge_status, noshow_consent_at")
    .eq("id", bookingId)
    .maybeSingle();
  const b = data as Row | null;
  if (!b) return { charged: false, reason: "booking not found" };
  if (!b.noshow_card_id) return { charged: false, reason: "no card on file" };
  if (b.noshow_charge_status === "charged") {
    return { charged: false, reason: "already charged" }; // idempotent
  }
  // Legal guard: never charge a saved card without recorded consent.
  if (!b.noshow_consent_at) {
    return { charged: false, reason: "no consent on file" };
  }
  const feeCents = num(b.noshow_fee_cents);
  if (feeCents <= 0) return { charged: false, reason: "fee is zero" };

  const provider = await resolvePaymentProvider(str(b.salon_id));
  if (!provider) return { charged: false, reason: "payment provider not configured" };
  try {
    const pay = await provider.chargeSavedCard({
      cardId: str(b.noshow_card_id),
      customerId: str(b.noshow_customer_id),
      amountCents: feeCents,
      idempotencyKey: `noshow:${bookingId}${opts?.idempotencySuffix ? `:${opts.idempotencySuffix}` : ""}`,
      note: "No-show fee",
      referenceId: `booking:${bookingId}`,
    });
    const charged = pay.status === "COMPLETED" || pay.status === "APPROVED";
    await db
      .from("bookings")
      .update({
        noshow_charge_status: charged ? "charged" : "failed",
        noshow_payment_id: pay.paymentId,
      } as never)
      .eq("id", bookingId);
    return { charged, reason: pay.status, paymentId: pay.paymentId };
  } catch (e) {
    await db
      .from("bookings")
      .update({ noshow_charge_status: "failed" } as never)
      .eq("id", bookingId);
    return { charged: false, reason: e instanceof Error ? e.message : "charge failed" };
  }
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
): Promise<{ checked: number; paid: number }> {
  const db = looseServiceClient();
  const { data } = await db
    .from("bookings")
    .select("id, noshow_fee_cents, noshow_fee_order_id, noshow_charge_status")
    .eq("salon_id", salonId)
    .not("noshow_fee_order_id", "is", null)
    .not("noshow_charge_status", "eq", "charged");
  const rows = (data as Row[]) ?? [];
  if (rows.length === 0) return { checked: 0, paid: 0 };

  const cfg = await getSquareConfig(db, salonId);
  let paid = 0;
  for (const r of rows) {
    const orderId = str(r.noshow_fee_order_id);
    if (!orderId) continue;
    try {
      const order = await getOrder(cfg, orderId);
      if (
        order.state === "COMPLETED" ||
        order.paidCents >= num(r.noshow_fee_cents)
      ) {
        await db
          .from("bookings")
          .update({
            noshow_charge_status: "charged",
            noshow_payment_id: order.tenderPaymentId,
          } as never)
          .eq("id", str(r.id));
        paid++;
      }
    } catch {
      // transient Square error — retry next run
    }
  }
  return { checked: rows.length, paid };
}
