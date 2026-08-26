/**
 * POST /api/twilio/inbound
 * Twilio inbound-SMS webhook — two-way reminders. A customer replies to a
 * reminder text with YES/CONFIRM or CANCEL; we update their booking and reply.
 *
 * Configure the Twilio number's Messaging webhook (SmsUrl) to POST here:
 *   https://nailiq.ca/api/twilio/inbound
 *
 * Validated with X-Twilio-Signature (HMAC-SHA1), mirroring /api/twilio/status.
 * Twilio Advanced Opt-Out remains provider-authoritative. Its signed
 * OptOutType is also recorded in NailIQ's durable suppression ledger before
 * any future outbound provider call.
 */

import { NextRequest, NextResponse, after } from "next/server";
import {
  getTwilioAuthToken,
  validateTwilioSignature,
  twilioRequestBaseUrl,
} from "@/shared/lib/twilioSignature";
import { readUrlEncodedFormWithLimit } from "@/shared/security/readUrlEncodedFormWithLimit";
import { classifyInboundSmsCommand } from "@/shared/reminders/inboundSmsCommand";
import { recordInboundSmsConsent } from "@/shared/reminders/smsConsentSuppression";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c,
  );
}

function twiml(message?: string): NextResponse {
  const inner = message ? `<Message>${xmlEscape(message)}</Message>` : "";
  return new NextResponse(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`,
    { status: 200, headers: { "Content-Type": "text/xml" } },
  );
}

export async function POST(req: NextRequest) {
  const form = await readUrlEncodedFormWithLimit(req, 16_384);
  if (!form) return new NextResponse("Invalid request", { status: 400 });
  const params = Object.fromEntries(form.entries());

  const { createServiceRoleClient } = await import("@/shared/lib/supabase/serviceRole");
  const supabase = createServiceRoleClient();
  const authToken = await getTwilioAuthToken(supabase);
  if (!authToken) {
    console.error("[twilio/inbound] auth token unavailable");
    return new NextResponse("Service unavailable", { status: 503 });
  }
  const signature = req.headers.get("x-twilio-signature") ?? "";
  const url = `${twilioRequestBaseUrl(req)}/api/twilio/inbound`;
  if (!validateTwilioSignature(url, params, signature, authToken)) {
    console.warn("[twilio/inbound] invalid signature");
    return new NextResponse("Forbidden", { status: 403 });
  }

  const action = classifyInboundSmsCommand(params.Body ?? "", params.OptOutType);
  if (action === "consent_help") return twiml();
  if (action === "consent_stop" || action === "consent_start") {
    const recorded = await recordInboundSmsConsent({
      accountSid: params.AccountSid ?? "",
      messageSid: params.MessageSid ?? params.SmsMessageSid ?? "",
      fromPhone: params.From ?? "",
      toPhone: params.To ?? "",
      optOutType: action === "consent_stop" ? "STOP" : "START",
    });
    // Twilio has already sent the configured Advanced Opt-Out reply. Return
    // empty TwiML to avoid a duplicate; a 503 asks Twilio to retry a failed
    // local persistence step under the same MessageSid.
    return recorded.ok
      ? twiml()
      : new NextResponse("Service unavailable", { status: 503 });
  }
  if (action === "unknown") return twiml();

  const { toCanonicalPhone } = await import("@/shared/lib/toCanonicalPhone");
  const phone = toCanonicalPhone(params.From ?? "");
  if (!phone) return twiml();

  const db = supabase;

  // The booking this reply is about: soonest upcoming pending/confirmed booking
  // for this phone. Prefer bookings that received a reminder (confirmation/winback/rebook);
  // fall back to any upcoming booking so a customer can confirm/cancel even if
  // the reminder SMS was the very first contact (e.g. win-back replies).
  const nowIso = new Date().toISOString();
  const baseQuery = db
    .from("bookings")
    .select("id, salon_id, service_id, start_time_utc, status, reminder_24h_sent_at, reminder_3h_sent_at, sms_confirmation_sent_at")
    .eq("client_phone", phone)
    .in("status", ["pending", "confirmed"])
    .gte("start_time_utc", nowIso)
    .order("start_time_utc", { ascending: true })
    .limit(5);

  const { data: bkRows } = await baseQuery;
  const rows = (bkRows ?? []) as Array<{
    id: string; salon_id: string; service_id: string; start_time_utc: string; status: string;
    reminder_24h_sent_at: string | null; reminder_3h_sent_at: string | null; sms_confirmation_sent_at: string | null;
  }>;

  // Prefer the booking that received a REMINDER; else the soonest.
  //
  // `sms_confirmation_sent_at` is deliberately not part of this test. It was
  // written by a `void`-ed query that never ran, so it has been NULL on every
  // booking and this predicate has only ever matched on the two reminder
  // columns. That write is fixed in this commit, and folding the confirmation
  // timestamp back in would silently retarget replies: a same-day booking made
  // too late for a reminder would start out-ranking the reminded booking the
  // customer is actually answering, so "CANCEL" could cancel the wrong one.
  //
  // Keeping the live behavior. Whether a reply should prefer the most recently
  // texted booking is a product question, not a side effect of a write fix.
  const bkWithSms = rows.find((r) => r.reminder_24h_sent_at || r.reminder_3h_sent_at);
  const bkRow = bkWithSms ?? rows[0] ?? null;

  if (!bkRow) {
    return twiml(
      "We couldn't find an upcoming appointment for this number. Please call the salon for help.",
    );
  }

  const bk = bkRow;

  const booking = bk;

  const { data: salonRow } = await db
    .from("salons")
    .select("name")
    .eq("id", booking.salon_id)
    .maybeSingle();
  const salonName = (salonRow as { name?: string } | null)?.name ?? "the salon";

  const { logNotification } = await import("@/shared/lib/notificationLog");

  if (action === "booking_confirm") {
    await db
      .from("bookings")
      .update({ status: "confirmed", confirmed_at: new Date().toISOString() } as never)
      .eq("id", booking.id)
      .eq("status", "pending");
    void logNotification({
      bookingId: booking.id,
      salonId: booking.salon_id,
      notificationType: "inbound_confirm",
      channel: "sms",
      clientPhone: phone,
      messageSid: params.MessageSid ?? null,
      bodyPreview: params.Body ?? null,
      ok: true,
    });
    return twiml(`✅ Confirmed! See you at ${salonName}. Reply NO if your plans change.`);
  }

  // action === "booking_cancel" — frees the slot + promotes the waitlist atomically.
  const { data: res, error: cancelError } = await db.rpc(
    "cancel_booking_by_id_with_waitlist_offer" as never,
    {
    p_booking_id: booking.id,
    } as never,
  );
  const cancelResult = res && typeof res === "object"
    ? (Array.isArray(res) ? res[0] : res) as Record<string, unknown> | undefined
    : undefined;
  const ok = !cancelError && cancelResult?.ok === true && cancelResult.code === "ok" &&
    cancelResult.booking_id === booking.id;
  void logNotification({
    bookingId: booking.id,
    salonId: booking.salon_id,
    notificationType: "inbound_cancel",
    channel: "sms",
    clientPhone: phone,
    messageSid: params.MessageSid ?? null,
    bodyPreview: params.Body ?? null,
    ok,
  });

  if (ok) {
    const { logBookingEvent } = await import("@/shared/dashboard/auditLog");
    void logBookingEvent({
      bookingId: booking.id,
      salonId: booking.salon_id,
      actorUserId: null,
      actorRole: "public_guest",
      eventType: "booking_cancelled",
      payload: { reason: "sms_cancel" },
    });
    const promotedWaitlist = cancelResult?.promoted_waitlist;
    if (promotedWaitlist) after(async () => {
      const { deliverCanonicalWaitlistPromotion } =
        await import("@/shared/noshow/promoteAndDeliverWaitlistOffer");
      const delivered = await deliverCanonicalWaitlistPromotion(promotedWaitlist);
      if (!delivered.ok) console.error("[twilio-inbound] canonical waitlist", delivered.code);
    });
  }
  return twiml(`Your appointment at ${salonName} is cancelled. Book again anytime — thank you!`);
}
