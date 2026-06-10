/**
 * POST /api/twilio/inbound
 * Twilio inbound-SMS webhook — two-way reminders. A customer replies to a
 * reminder text with YES/CONFIRM or CANCEL; we update their booking and reply.
 *
 * Configure the Twilio number's Messaging webhook (SmsUrl) to POST here:
 *   https://nailiq.ca/api/twilio/inbound
 *
 * Validated with X-Twilio-Signature (HMAC-SHA1), mirroring /api/twilio/status.
 * STOP/START opt-out is handled by Twilio Advanced Opt-Out, not here.
 */

import { NextRequest, NextResponse, after } from "next/server";
import crypto from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
  authToken: string,
): boolean {
  const sortedKeys = Object.keys(params).sort();
  const data = url + sortedKeys.map((k) => k + (params[k] ?? "")).join("");
  const computed = crypto.createHmac("sha1", authToken).update(data).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function getTwilioAuthToken(): Promise<string | null> {
  try {
    const { createServiceRoleClient } = await import("@/shared/lib/supabase/serviceRole");
    const supabase = createServiceRoleClient();
    const { data } = await supabase
      .from("platform_settings")
      .select("twilio_auth_token")
      .eq("id", "platform")
      .maybeSingle();
    const token = (data as { twilio_auth_token?: string | null } | null)?.twilio_auth_token?.trim();
    if (token) return token;
  } catch {
    /* fall through to env */
  }
  return process.env.TWILIO_AUTH_TOKEN?.trim() ?? null;
}

// Bilingual command words. Single-word replies are how customers actually answer.
const CONFIRM_WORDS = new Set([
  "yes", "y", "yeah", "yep", "ya", "ok", "okay", "k", "confirm", "confirmed",
  "c", "có", "co", "xacnhan", "dongy",
]);
const CANCEL_WORDS = new Set([
  "cancel", "cancelled", "no", "n", "huy", "hủy", "huỷ", "khong", "không",
]);

function classify(body: string): "confirm" | "cancel" | "unknown" {
  const norm = body.trim().toLowerCase().replace(/[.!,?]/g, "");
  if (CONFIRM_WORDS.has(norm)) return "confirm";
  if (CANCEL_WORDS.has(norm)) return "cancel";
  // Tolerate "yes please" / "cancel it" — judge on the first word only.
  const first = norm.split(/\s+/)[0] ?? "";
  if (CONFIRM_WORDS.has(first)) return "confirm";
  if (CANCEL_WORDS.has(first)) return "cancel";
  return "unknown";
}

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
  const rawBody = await req.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody).entries());

  const authToken = await getTwilioAuthToken();
  if (authToken) {
    const signature = req.headers.get("x-twilio-signature") ?? "";
    const url =
      (process.env.NEXT_PUBLIC_APP_URL ?? "https://nailiq.ca").replace(/\/$/, "") +
      "/api/twilio/inbound";
    if (signature && !validateTwilioSignature(url, params, signature, authToken)) {
      console.warn("[twilio/inbound] invalid signature");
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  const action = classify(params.Body ?? "");
  // Ignore anything that isn't a clear command (incl. STOP/START → Twilio handles).
  if (action === "unknown") return twiml();

  const { toCanonicalPhone } = await import("@/shared/lib/toCanonicalPhone");
  const phone = toCanonicalPhone(params.From ?? "");
  if (!phone) return twiml();

  const { createServiceRoleClient } = await import("@/shared/lib/supabase/serviceRole");
  const db = createServiceRoleClient();

  // The booking this reply is about: soonest upcoming pending/confirmed booking
  // for this phone that actually got a reminder.
  const { data: bk } = await db
    .from("bookings")
    .select("id, salon_id, service_id, start_time_utc, status")
    .eq("client_phone", phone)
    .in("status", ["pending", "confirmed"])
    .gte("start_time_utc", new Date().toISOString())
    .or("reminder_24h_sent_at.not.is.null,reminder_3h_sent_at.not.is.null")
    .order("start_time_utc", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!bk) {
    return twiml(
      "We couldn't find an upcoming appointment for this number. Please call the salon for help.",
    );
  }

  const booking = bk as {
    id: string;
    salon_id: string;
    service_id: string;
    start_time_utc: string;
  };

  const { data: salonRow } = await db
    .from("salons")
    .select("name")
    .eq("id", booking.salon_id)
    .maybeSingle();
  const salonName = (salonRow as { name?: string } | null)?.name ?? "the salon";

  const { logNotification } = await import("@/shared/lib/notificationLog");

  if (action === "confirm") {
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
    return twiml(`✅ Confirmed! See you at ${salonName}. Reply CANCEL if your plans change.`);
  }

  // action === "cancel" — frees the slot + promotes the waitlist atomically.
  const { data: res } = await db.rpc("cancel_booking_by_id" as never, {
    p_booking_id: booking.id,
  });
  const ok = (Array.isArray(res) ? (res[0] as { ok?: boolean } | undefined) : undefined)?.ok === true;
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
    const bookingDateYmd = booking.start_time_utc.split("T")[0];
    after(async () => {
      const { notifyWaitlistForSlot } = await import("@/shared/noshow/waitlistAutoFill");
      const { data: svc } = await db
        .from("services")
        .select("name")
        .eq("id", booking.service_id)
        .maybeSingle();
      const serviceName = (svc as { name?: string } | null)?.name ?? "";
      await notifyWaitlistForSlot({
        salonId: booking.salon_id,
        salonName,
        serviceId: booking.service_id,
        serviceName,
        bookingDateYmd,
      });
    });
  }
  return twiml(`Your appointment at ${salonName} is cancelled. Book again anytime — thank you!`);
}
