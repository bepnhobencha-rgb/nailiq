/**
 * Square deposit collection (risk-gated, % of service price).
 *
 * - createDepositForBooking: if the salon enabled deposits AND the booking's
 *   no_show_risk_score >= threshold, create a Square payment link for
 *   round(price * percent), stamp the booking (deposit_required/amount/status +
 *   square link ids), and return the pay URL. Idempotent: a booking that already
 *   has a link returns it instead of creating a second.
 * - reconcileDeposits: for the salon's pending-deposit bookings, check the
 *   Square order and flip deposit_status -> 'paid' once the link is paid. Called
 *   from the square-sync cron each run.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { looseServiceClient, type Row } from "./looseDb";
import { getSquareConfig, createPaymentLink, getOrder, refundPayment } from "./client";

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => (v == null ? 0 : Number(v));

export interface DepositResult {
  required: boolean;
  reason: string;
  url?: string;
  amountCents?: number;
}

async function loadPolicy(db: ReturnType<typeof looseServiceClient>, salonId: string) {
  const { data } = await db
    .from("square_integrations")
    .select("deposit_enabled, deposit_percent, deposit_risk_threshold")
    .eq("salon_id", salonId)
    .maybeSingle();
  const r = (data as Row) ?? {};
  return {
    enabled: Boolean(r.deposit_enabled),
    percent: num(r.deposit_percent) || 30,
    threshold: num(r.deposit_risk_threshold) || 60,
  };
}

export async function createDepositForBooking(
  bookingId: string,
  /** `manual: true` — a receptionist is requesting the deposit at the desk, so
   *  skip the no-show-risk gate (the human decided it's warranted). The salon
   *  still has to have Square deposits enabled — that's a config gate, not a
   *  risk one. */
  opts?: { manual?: boolean },
): Promise<DepositResult> {
  const db = looseServiceClient();
  const { data: bRow } = await db
    .from("bookings")
    .select("id, salon_id, price_cents, no_show_risk_score, deposit_status, deposit_amount_cents, square_payment_link_id, deposit_link_url, client_name")
    .eq("id", bookingId)
    .maybeSingle();
  const b = bRow as Row | null;
  if (!b) return { required: false, reason: "booking not found" };

  // Already has a link -> return it (idempotent). Surface the stored amount so
  // callers (e.g. the SMS sender) don't have to re-read the booking.
  if (b.deposit_link_url) {
    return {
      required: true,
      reason: "existing link",
      url: str(b.deposit_link_url),
      amountCents: num(b.deposit_amount_cents) || undefined,
    };
  }

  const salonId = str(b.salon_id);
  const policy = await loadPolicy(db, salonId);
  if (!policy.enabled) return { required: false, reason: "deposits disabled for salon" };

  const risk = num(b.no_show_risk_score);
  const manual = opts?.manual === true;
  if (!manual && risk < policy.threshold) {
    return { required: false, reason: `risk ${risk} < threshold ${policy.threshold}` };
  }

  const amountCents = Math.max(100, Math.round(num(b.price_cents) * policy.percent / 100));
  const cfg = await getSquareConfig(db, salonId);
  const link = await createPaymentLink(cfg, {
    amountCents,
    name: `Deposit — ${str(b.client_name) || "appointment"}`,
    referenceId: bookingId,
    idempotencyKey: randomUUID(),
    note: `NailIQ deposit for booking ${bookingId}`,
  });

  await db.from("bookings").update({
    deposit_required: true,
    deposit_amount_cents: amountCents,
    deposit_status: "required",
    deposit_reason: manual
      ? "manual desk request"
      : `no_show_risk ${risk} >= ${policy.threshold}`,
    square_payment_link_id: link.id,
    square_deposit_order_id: link.orderId,
    deposit_link_url: link.url,
  }).eq("id", bookingId);

  return { required: true, reason: "deposit link created", url: link.url, amountCents };
}

/**
 * Refund a paid Square deposit (mutually-agreed cancel). Returns ok:false with a
 * reason the desk can surface (e.g. refund manually in Square) rather than throwing.
 */
export async function refundDeposit(bookingId: string): Promise<{ ok: boolean; reason: string; refundedCents?: number }> {
  const db = looseServiceClient();
  const { data } = await db
    .from("bookings")
    .select("id, salon_id, deposit_status, deposit_amount_cents, square_payment_id")
    .eq("id", bookingId)
    .maybeSingle();
  const b = data as Row | null;
  if (!b) return { ok: false, reason: "booking not found" };
  if (str(b.deposit_status) !== "paid") return { ok: false, reason: "no paid deposit" };

  const paymentId = str(b.square_payment_id);
  const amount = num(b.deposit_amount_cents);
  if (!paymentId || amount <= 0) return { ok: false, reason: "missing payment id — refund manually in Square" };

  const cfg = await getSquareConfig(db, str(b.salon_id));
  try {
    await refundPayment(cfg, {
      paymentId,
      amountCents: amount,
      reason: "Booking cancelled — deposit refund",
      idempotencyKey: randomUUID(),
    });
  } catch (e) {
    return { ok: false, reason: `Square refund failed: ${(e as Error).message}` };
  }
  await db.from("bookings").update({ deposit_status: "refunded" }).eq("id", bookingId);
  return { ok: true, reason: "refunded", refundedCents: amount };
}

/** Flip pending deposits to 'paid' once their Square link is paid. */
export async function reconcileDeposits(salonId: string): Promise<{ checked: number; paid: number }> {
  const db = looseServiceClient();
  const cfg = await getSquareConfig(db, salonId);
  const { data } = await db
    .from("bookings")
    .select("id, deposit_amount_cents, square_deposit_order_id")
    .eq("salon_id", salonId)
    .eq("deposit_status", "required")
    .not("square_deposit_order_id", "is", null);
  const rows = (data as Row[]) ?? [];
  let paid = 0;
  for (const r of rows) {
    const orderId = str(r.square_deposit_order_id);
    if (!orderId) continue;
    try {
      const order = await getOrder(cfg, orderId);
      if (order.state === "COMPLETED" || order.paidCents >= num(r.deposit_amount_cents)) {
        await db.from("bookings").update({ deposit_status: "paid", square_payment_id: order.tenderPaymentId }).eq("id", str(r.id));
        paid++;
      }
    } catch {
      // transient Square error — try again next run
    }
  }
  return { checked: rows.length, paid };
}
