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
import { evaluateDeposit } from "@/shared/noshow/evaluateDeposit";

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** Per-salon TIERED deposit config (admin-set), so the desk deposit is as smart
 *  as the online flow: different % for new / no-show / high-value. */
async function loadTieredConfig(db: ReturnType<typeof looseServiceClient>, salonId: string) {
  const { data } = await db
    .from("salons")
    .select("deposit_pct_no_show, deposit_pct_high_value, deposit_pct_new_customer, deposit_high_value_cents")
    .eq("id", salonId)
    .maybeSingle();
  const r = (data as Row) ?? {};
  return {
    pctNoShow: num(r.deposit_pct_no_show) || 50,
    pctHighValue: num(r.deposit_pct_high_value) || 30,
    pctNewCustomer: num(r.deposit_pct_new_customer) || 20,
    highValueCents: num(r.deposit_high_value_cents) || 10000,
  };
}

/** Risk signals from the phone-keyed client profile — same source the online
 *  deposit flow uses, so a desk deposit reads the customer identically. */
async function depositSignals(db: ReturnType<typeof looseServiceClient>, phone: string) {
  let isNewCustomer = true;
  let previousNoShowCount = 0;
  let isVip = false;
  const p = phone.trim();
  if (p) {
    const { data } = await db
      .from("client_profiles")
      .select("no_show_count, is_vip, visit_count")
      .eq("phone", p)
      .maybeSingle();
    const r = (data ?? {}) as { no_show_count?: number; is_vip?: boolean; visit_count?: number };
    previousNoShowCount = Math.max(0, Math.round(num(r.no_show_count)));
    isVip = Boolean(r.is_vip);
    isNewCustomer = !(num(r.visit_count) > 0);
  }
  return { isNewCustomer, previousNoShowCount, isVip };
}

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
  opts?: { manual?: boolean; hold?: boolean },
): Promise<DepositResult> {
  const db = looseServiceClient();
  const { data: bRow } = await db
    .from("bookings")
    .select("id, salon_id, status, price_cents, no_show_risk_score, deposit_status, deposit_amount_cents, square_payment_link_id, deposit_link_url, client_name, client_phone")
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

  // SMART amount — tier by who the customer is (new / prior no-show / high-value /
  // VIP-exempt), same engine + signals as the online flow, instead of a flat %.
  const tier = await loadTieredConfig(db, salonId);
  const signals = await depositSignals(db, str(b.client_phone));
  const evalInput = {
    isNewCustomer: signals.isNewCustomer,
    previousNoShowCount: signals.previousNoShowCount,
    isVip: signals.isVip,
    servicePriceCents: num(b.price_cents),
    highValueThresholdCents: tier.highValueCents,
    pctNoShow: tier.pctNoShow,
    pctHighValue: tier.pctHighValue,
    pctNewCustomer: tier.pctNewCustomer,
  };
  let decision = evaluateDeposit(evalInput);
  // Desk override: the receptionist explicitly requested a deposit, so require it
  // even when no automatic tier matched (loyal / low-risk / VIP) — at the
  // high-value %. An auto (non-manual) call past the risk gate does the same.
  if (!decision.required) {
    decision = evaluateDeposit({ ...evalInput, ownerOverride: "require" });
  }
  if (!decision.required || decision.amountCents <= 0) {
    return { required: false, reason: "no deposit rule matched" };
  }
  const amountCents = Math.max(100, decision.amountCents);

  const cfg = await getSquareConfig(db, salonId);
  const link = await createPaymentLink(cfg, {
    amountCents,
    name: `Deposit — ${str(b.client_name) || "appointment"}`,
    referenceId: bookingId,
    idempotencyKey: randomUUID(),
    note: `NailIQ deposit for booking ${bookingId}`,
  });

  // hold = "pay-to-confirm": the slot is only held until the deposit is paid; if
  // unpaid past the grace window the release-pending cron cancels it. Explicit
  // opt-in (default OFF) so existing "just collect a deposit" callers are
  // unchanged — the desk "hold slot" action passes hold:true.
  const hold = opts?.hold === true;
  // Pay-to-confirm: a held booking reads as "Chờ cọc" not "Xác nhận", so move a
  // currently-confirmed slot to `pending` until payment (reconcile flips it back
  // to confirmed). Only downgrade from confirmed — never touch in_progress /
  // completed / etc. The OTP-15min release cron is guarded against deposit_hold,
  // so the slot is only released by the deposit grace window.
  const patch: Record<string, unknown> = {
    deposit_required: true,
    deposit_amount_cents: amountCents,
    deposit_status: "required",
    deposit_reason: manual
      ? `manual desk request (${decision.reason ?? "forced"})`
      : `smart: ${decision.reason ?? "rule_applied"}`,
    square_payment_link_id: link.id,
    square_deposit_order_id: link.orderId,
    deposit_link_url: link.url,
    deposit_hold: hold,
    deposit_requested_at: new Date().toISOString(),
  };
  if (hold && str(b.status) === "confirmed") patch.status = "pending";
  await db.from("bookings").update(patch as never).eq("id", bookingId);

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
    .select("id, status, deposit_hold, deposit_amount_cents, square_deposit_order_id")
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
        // Paid → flip to paid, stamp time, and RELEASE the hold so the cron no
        // longer eyes it for cancellation. If the slot was held as `pending`
        // (pay-to-confirm), promote it back to `confirmed` now that it's paid.
        const upd: Record<string, unknown> = {
          deposit_status: "paid",
          square_payment_id: order.tenderPaymentId,
          deposit_paid_at: new Date().toISOString(),
          deposit_hold: false,
        };
        if (r.deposit_hold === true && str(r.status) === "pending") upd.status = "confirmed";
        await db.from("bookings").update(upd as never).eq("id", str(r.id));
        paid++;
      }
    } catch {
      // transient Square error — try again next run
    }
  }
  return { checked: rows.length, paid };
}
