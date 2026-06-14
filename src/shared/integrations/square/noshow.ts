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
import { randomUUID } from "node:crypto";
import { looseServiceClient, type Row } from "./looseDb";
import {
  getSquareConfig,
  ensureSquareCustomer,
  saveCardOnFile,
  chargeSavedCard,
} from "./client";

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => (v == null ? 0 : Number(v));

type Db = ReturnType<typeof looseServiceClient>;

async function loadPolicy(db: Db, salonId: string) {
  const { data } = await db
    .from("square_integrations")
    .select("enabled, deposit_enabled, deposit_percent, deposit_risk_threshold")
    .eq("salon_id", salonId)
    .maybeSingle();
  const r = (data as Row) ?? {};
  return {
    connected: Boolean(r.enabled),
    enabled: Boolean(r.deposit_enabled),
    percent: num(r.deposit_percent) || 20,
    threshold: num(r.deposit_risk_threshold) || 60,
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
  if (!policy.connected || !policy.enabled) {
    return { required: false, feeCents: 0, reason: "no-show protection off" };
  }

  // Gate: a NEW customer (no prior non-cancelled booking at this salon) always
  // leaves a card; returning customers only when their no-show risk is high.
  // Loyal returning clients with a clean history are never asked (low friction).
  const risk = num(b.no_show_risk_score);
  const isNew = await isNewCustomer(db, str(b.salon_id), str(b.client_phone), bookingId);
  const highRisk = risk >= policy.threshold;
  if (!isNew && !highRisk) {
    return {
      required: false,
      feeCents: 0,
      reason: `returning + risk ${risk} < ${policy.threshold}`,
    };
  }

  const feeCents = Math.round((num(b.price_cents) * policy.percent) / 100);
  if (feeCents <= 0) return { required: false, feeCents: 0, reason: "fee is zero" };
  return {
    required: true,
    feeCents,
    reason: isNew ? "new customer" : `risk ${risk} ≥ ${policy.threshold}`,
  };
}

/** True when this phone has no OTHER non-cancelled booking at the salon — i.e.
 *  a first-time customer. Empty/short phone → treated as new (safer to protect). */
async function isNewCustomer(
  db: Db,
  salonId: string,
  clientPhone: string,
  excludeBookingId: string,
): Promise<boolean> {
  const phone = clientPhone.trim();
  if (phone.length < 8) return true;
  const { data } = await db
    .from("bookings")
    .select("id")
    .eq("salon_id", salonId)
    .eq("client_phone", phone)
    .not("id", "eq", excludeBookingId)
    .not("status", "eq", "cancelled")
    .limit(1);
  return (data?.length ?? 0) === 0;
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

  const cfg = await getSquareConfig(db, str(b.salon_id));
  const customerId = await ensureSquareCustomer(cfg, {
    name: str(b.client_name) || null,
    phone: str(b.client_phone) || null,
    email: str(b.client_email) || null,
    referenceId: `booking:${bookingId}`,
    idempotencyKey: randomUUID(),
  });
  const card = await saveCardOnFile(cfg, {
    customerId,
    sourceId,
    idempotencyKey: randomUUID(),
  });

  await db
    .from("bookings")
    .update({
      noshow_card_id: card.cardId,
      noshow_customer_id: customerId,
      noshow_fee_cents: decision.feeCents,
      noshow_charge_status: "saved",
      noshow_consent_at: new Date().toISOString(),
    } as never)
    .eq("id", bookingId);

  return { ok: true, reason: "saved", last4: card.last4 };
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

  const cfg = await getSquareConfig(db, str(b.salon_id));
  try {
    const pay = await chargeSavedCard(cfg, {
      cardId: str(b.noshow_card_id),
      customerId: str(b.noshow_customer_id),
      amountCents: feeCents,
      idempotencyKey: `noshow:${bookingId}`, // stable → Square dedups a double-charge
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
