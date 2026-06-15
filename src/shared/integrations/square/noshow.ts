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
  });

  // Server-authored consent evidence: the exact terms the customer agreed to,
  // captured at save time (amount + currency + plain-English policy). Stored as
  // proof for a chargeback dispute — never trust the client to supply this.
  const { data: salonRow } = await db
    .from("salons")
    .select("currency_code")
    .eq("id", str(b.salon_id))
    .maybeSingle();
  const currency = String((salonRow as Row | null)?.currency_code || "USD").trim().toUpperCase() || "USD";
  const feeStr = `${(decision.feeCents / 100).toFixed(2)} ${currency}`;
  const consentMeta = {
    policyText: `Cardholder authorized this salon to keep this card on file and to charge a no-show fee of ${feeStr} only if they do not show up for this appointment. No charge is made at booking. The cardholder may remove the card at any time.`,
    feeCents: decision.feeCents,
    currency,
    cardBrand: saved.brand,
    cardLast4: saved.last4,
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

  return { ok: true, reason: "reused", last4: card.last4 };
}

/** Charge the saved card for the no-show fee. Called when a booking is marked
 *  no-show. Idempotent and safe to call on bookings without a saved card. */
export async function chargeNoShowFee(
  bookingId: string,
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
      idempotencyKey: `noshow:${bookingId}`, // stable → provider dedups a double-charge
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
