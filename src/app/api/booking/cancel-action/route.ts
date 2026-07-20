import { after } from "next/server";
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { notifyWaitlistForSlot } from "@/shared/noshow/waitlistAutoFill";
import { logBookingEvent } from "@/shared/dashboard/auditLog";
import { deliverStaffActionNotification } from "@/shared/notifications/deliverStaffActionNotification";
import { sendOwnerBookingNotification } from "@/shared/dashboard/sendOwnerBookingNotification";
import { chargeNoShowFee } from "@/shared/integrations/square/noshow";
import { salonYmdOfUtc } from "@/shared/lib/salonTime";

type BookingRow = {
  salon_id: string;
  service_id: string;
  start_time_utc: string;
  status: string | null;
  client_email: string | null;
  client_locale: string | null;
  noshow_card_id: string | null;
  noshow_consent_at: string | null;
  noshow_fee_cents: number | null;
  noshow_charge_status: string | null;
  noshow_card_last4: string | null;
  noshow_card_brand: string | null;
};

type SalonRow = {
  slug: string | null;
  currency_code: string | null;
  self_cancel_fee_enabled: boolean | null;
  self_cancel_window_hours: number | null;
  self_cancel_fee_percent: number | null;
  noshow_fee_percent: number | null;
};

/**
 * Resolve a reminder token to its booking + salon and decide what a self-cancel
 * would do RIGHT NOW: is the appointment already past (block), is it inside the
 * salon's cancellation window (late), and would a fee be charged (late + saved
 * card + consent + salon opted in). Shared by the GET preview (so the customer
 * sees the fee BEFORE confirming) and the POST that performs the cancel.
 */
async function evaluateSelfCancel(
  supabase: ReturnType<typeof createServiceRoleClient>,
  token: string,
): Promise<
  | { ok: false; code: string }
  | {
      ok: true;
      bookingId: string;
      booking: BookingRow;
      salon: SalonRow;
      startPast: boolean;
      withinWindow: boolean;
      willCharge: boolean;
      feeCents: number;
    }
> {
  const { data: tokenRow } = await supabase
    .from("booking_reminder_tokens" as never)
    .select("booking_id, used_at, expires_at")
    .eq("id", token)
    .maybeSingle();
  const tr = tokenRow as
    | { booking_id: string; used_at: string | null; expires_at: string }
    | null;
  if (!tr) return { ok: false, code: "token_invalid" };
  if (tr.used_at !== null || new Date(tr.expires_at) < new Date())
    return { ok: false, code: "token_invalid" };

  const { data: bRow } = await supabase
    .from("bookings" as never)
    .select(
      "salon_id, service_id, start_time_utc, status, client_email, client_locale, noshow_card_id, noshow_consent_at, noshow_fee_cents, noshow_charge_status, noshow_card_last4, noshow_card_brand",
    )
    .eq("id", tr.booking_id)
    .maybeSingle();
  const booking = bRow as BookingRow | null;
  if (!booking) return { ok: false, code: "booking_not_cancellable" };
  if (booking.status !== "pending" && booking.status !== "confirmed")
    return { ok: false, code: "booking_not_cancellable" };

  const { data: salonRow } = await supabase
    .from("salons" as never)
    .select(
      "slug, currency_code, self_cancel_fee_enabled, self_cancel_window_hours, self_cancel_fee_percent, noshow_fee_percent",
    )
    .eq("id", booking.salon_id)
    .maybeSingle();
  const salon = (salonRow as SalonRow | null) ?? {
    slug: null,
    currency_code: null,
    self_cancel_fee_enabled: false,
    self_cancel_window_hours: 24,
    self_cancel_fee_percent: null,
    noshow_fee_percent: null,
  };

  const now = Date.now();
  const start = new Date(booking.start_time_utc).getTime();
  const startPast = !Number.isFinite(start) || start <= now;
  const windowHours =
    salon.self_cancel_window_hours != null && salon.self_cancel_window_hours > 0
      ? salon.self_cancel_window_hours
      : 24;
  const hoursUntil = (start - now) / 3_600_000;
  const withinWindow = !startPast && hoursUntil < windowHours;

  // The frozen no-show snapshot (noshow_fee_cents) is noshow_fee_percent% of the
  // booking base. If the salon set a gentler late-cancel percent, scale it:
  //   lateFee = snapshot * selfCancelPct / noshowPct
  const snapshotCents = booking.noshow_fee_cents ?? 0;
  const noshowPct = salon.noshow_fee_percent ?? 0;
  const selfPct = salon.self_cancel_fee_percent;
  const feeCents =
    selfPct != null && noshowPct > 0
      ? Math.round((snapshotCents * selfPct) / noshowPct)
      : snapshotCents;

  const hasChargeableCard =
    !!booking.noshow_card_id &&
    !!booking.noshow_consent_at &&
    feeCents > 0 &&
    booking.noshow_charge_status !== "charged";
  const willCharge =
    salon.self_cancel_fee_enabled === true && withinWindow && hasChargeableCard;

  return {
    ok: true,
    bookingId: tr.booking_id,
    booking,
    salon,
    startPast,
    withinWindow,
    willCharge,
    feeCents,
  };
}

/**
 * Preview endpoint — the cancel page fetches this on load so it can show the
 * late-cancel fee warning (or "call the salon" for a past appointment) BEFORE
 * the customer confirms. Read-only; never cancels or charges.
 */
export async function GET(req: Request) {
  const token = (new URL(req.url).searchParams.get("token") ?? "").trim();
  if (!token)
    return NextResponse.json({ ok: false, code: "missing_token" }, { status: 400 });

  const supabase = createServiceRoleClient();
  const ev = await evaluateSelfCancel(supabase, token);
  if (!ev.ok) return NextResponse.json({ ok: false, code: ev.code });

  return NextResponse.json({
    ok: true,
    startPast: ev.startPast,
    withinWindow: ev.withinWindow,
    willCharge: ev.willCharge,
    feeCents: ev.willCharge ? ev.feeCents : 0,
    last4: ev.willCharge ? ev.booking.noshow_card_last4 : null,
    brand: ev.willCharge ? ev.booking.noshow_card_brand : null,
    currency: ev.salon.currency_code ?? "USD",
    salonSlug: ev.salon.slug ?? null,
  });
}

export async function POST(req: Request) {
  let body: { token?: string };
  try {
    body = (await req.json()) as { token?: string };
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_body" }, { status: 400 });
  }

  const token = (body.token ?? "").trim();
  if (!token) {
    return NextResponse.json({ ok: false, code: "missing_token" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  const ev = await evaluateSelfCancel(supabase, token);
  if (!ev.ok) {
    return NextResponse.json({ ok: false, code: ev.code }, { status: 400 });
  }

  // Bug fix: never let the self-serve link cancel an appointment that has
  // already started (the token stays valid up to 2h past start). Past-start
  // means the salon should decide (attended / no-show), not the customer.
  if (ev.startPast) {
    return NextResponse.json({ ok: false, code: "too_late" }, { status: 400 });
  }

  const { salon_id, service_id, start_time_utc, client_email } = ev.booking;
  const bookingId = ev.bookingId;
  const salonSlug = ev.salon.slug ?? null;

  const { data, error } = await supabase.rpc("cancel_booking_as_customer" as never, {
    p_token_id: token,
  });

  if (error) {
    console.error("[cancel-action] RPC error", error);
    return NextResponse.json({ ok: false, code: "server_error" }, { status: 500 });
  }

  const rows = Array.isArray(data) ? data : [];
  const row = rows[0] as { ok?: boolean; code?: string } | undefined;

  if (!row?.ok) {
    return NextResponse.json({ ok: false, code: row?.code ?? "unknown" }, { status: 400 });
  }

  // Audit log — customer cancelled via email link
  void logBookingEvent({
    bookingId,
    salonId: salon_id,
    actorUserId: null,
    actorRole: "public_guest",
    eventType: "booking_cancelled",
    payload: { reason: "customer_email_link", late: ev.withinWindow },
  });

  // Late-cancel fee — charge synchronously so the response can tell the customer
  // exactly what happened. chargeNoShowFee is idempotent, re-guards card +
  // consent + fee, and records saved→charged|failed. The booking is already
  // cancelled above; a charge failure does not un-cancel it (mirrors no-show).
  let feeCharged = false;
  let feeCents = 0;
  if (ev.willCharge) {
    try {
      const res = await chargeNoShowFee(bookingId, {
        note: "Late cancellation fee",
        amountCentsOverride: ev.feeCents,
      });
      feeCharged = res.charged;
      if (res.charged) feeCents = ev.feeCents;
    } catch (e) {
      console.error("[cancel-action] late-cancel charge failed", e);
    }
  }

  // Owner alert + customer email + waitlist after the response is flushed.
  after(async () => {
    // Owner/manager alert — customer self-cancelled via email link.
    await sendOwnerBookingNotification({
      salonId: salon_id,
      bookingId,
      event: "cancel",
    });

    const sb = createServiceRoleClient();
    const [{ data: salonData }, { data: svcData }] = await Promise.all([
      sb.from("salons" as never).select("name, timezone").eq("id", salon_id).maybeSingle(),
      sb.from("services" as never).select("name").eq("id", service_id).maybeSingle(),
    ]);
    const salonName = (salonData as { name: string } | null)?.name ?? "";
    const serviceName = (svcData as { name: string } | null)?.name ?? "";
    // Freed slot's date must be the SALON-LOCAL day: booking_waitlist_entries
    // stores booking_date salon-local and the flip RPC matches it in the salon
    // tz, and notifyWaitlistForSlot now filters on it. The UTC day missed the
    // just-promoted waitlister for evening NA cancellations. Mirror reschedule.
    const timezone =
      (salonData as { timezone?: string | null } | null)?.timezone?.trim() ||
      "America/Los_Angeles";
    const bookingDateYmd = salonYmdOfUtc(start_time_utc, timezone);

    // Send cancellation confirmation email to the customer
    if (client_email) {
      try {
        await deliverStaffActionNotification(sb, {
          salonId: salon_id,
          bookingId,
          event: "cancel",
          channels: { email: true, sms: false },
        });
      } catch {
        /* best-effort */
      }
    }

    await notifyWaitlistForSlot({ salonId: salon_id, salonName, serviceId: service_id, serviceName, bookingDateYmd });
  });

  return NextResponse.json({
    ok: true,
    salonSlug,
    feeCharged,
    feeCents,
    currency: ev.salon.currency_code ?? "USD",
  });
}
