// POST /api/booking/sms-confirm
// Sends bilingual confirmation SMS and tracks delivery status on the booking row.
// Checks customer_preferences for preferred language; defaults to Vietnamese.

import * as ErrorReporter from "@/shared/observability/errorReporter";
import { NextResponse } from "next/server";
import { z } from "zod";
import { buildSmsConsentMeta } from "@/shared/booking/smsConsentRecord";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import { logNotification } from "@/shared/lib/notificationLog";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { sendBookingConfirmationEmail } from "@/shared/booking/sendBookingConfirmationEmail";
import { generateReminderToken } from "@/shared/noshow/generateReminderToken";

export const dynamic = "force-dynamic";

function formatConfirmDate(isoUtc: string, timezone = "America/Vancouver"): string {
  try {
    return new Date(isoUtc).toLocaleString("en-CA", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
      timeZoneName: "short",
    });
  } catch {
    return isoUtc;
  }
}

const BodySchema = z.object({
  bookingId: z.string().uuid(),
  salonId: z.string().uuid(),
  clientPhone: z.string().min(1),
  clientName: z.string().nullish(),
  serviceName: z.string().nullish(),
  staffName: z.string().nullish(),
  startTimeUtc: z.string().min(1),
  /** Language the customer chose at booking — wins over any stored pref. */
  language: z.enum(["en", "vi"]).nullish(),
  /** Set (>1) for a GROUP booking → one party-summary message instead of a
   *  per-service line. serviceName is then not required. */
  partySize: z.number().int().positive().optional(),
  /** The customer ticked the required SMS-consent box in their browser. Callers
   *  that never showed a checkbox (desk, voice) must omit this — see
   *  smsConsentRecord.ts on why a fabricated record is worse than none. */
  smsConsent: z.boolean().optional(),
  /** Group id — used to label the consent record, never to widen the write. */
  groupId: z.string().uuid().optional(),
});

export async function POST(req: Request) {
  const raw = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const { bookingId, salonId, clientName, serviceName, staffName, startTimeUtc, language, partySize, smsConsent, groupId } =
    parsed.data;

  const isGroup = typeof partySize === "number" && partySize > 1;

  if (!isGroup && !serviceName) {
    return NextResponse.json({ ok: false, error: "missing_fields" }, { status: 400 });
  }

  const db = createServiceRoleClient();

  // This route is public and uses the service-role client, so the booking must
  // be proven to belong to `salonId` before anything is written or texted.
  // Without it, a caller could stamp consent on another tenant's booking, and
  // `clientPhone` from the body turned this into an open SMS relay.
  const { data: bookingRow } = await db
    .from("bookings")
    .select("id, salon_id, group_id, client_phone")
    .eq("id", bookingId)
    .maybeSingle();

  const booking = bookingRow as
    | { id: string; salon_id: string; group_id: string | null; client_phone: string | null }
    | null;

  if (!booking) return NextResponse.json({ ok: false, error: "booking_not_found" }, { status: 404 });
  if (booking.salon_id !== salonId) {
    return NextResponse.json({ ok: false, error: "salon_mismatch" }, { status: 403 });
  }
  if (groupId && booking.group_id !== groupId) {
    return NextResponse.json({ ok: false, error: "group_mismatch" }, { status: 403 });
  }

  // Destination comes from the booking row, never from the body.
  const clientPhone = booking.client_phone?.trim();
  if (!clientPhone) return NextResponse.json({ ok: false, error: "no_phone" }, { status: 400 });

  // Check if SMS is enabled for this salon
  const { data: salon } = await db
    .from("salons")
    .select("name, slug, subscription_plan, plan_override, address, sms_outbound_enabled, email_outbound_enabled, timezone, default_notification_locale")
    .eq("id", salonId)
    .maybeSingle();

  if (!salon) return NextResponse.json({ ok: false, error: "salon_not_found" }, { status: 404 });

  // Express SMS consent, recorded before the Twilio send so the record persists
  // whether or not the message goes out. It runs after the salon lookup because
  // the stored disclosure has to name the salon the customer actually read.
  //
  // Must be awaited: a PostgrestBuilder only issues its HTTP request from
  // `then()`, so the previous `void db.from(...).update(...)` built the query
  // and dropped it — no booking ever got a consent stamp.
  //
  // Stamped on THIS booking only. The group path used to fan out across
  // `group_id`, writing the organizer's IP and user agent onto every party
  // member's row as if each had consented personally. Only the organizer ticks
  // the box, and the party shares their phone, so the organizer's booking is
  // the one row the evidence belongs to.
  //
  // `.is("sms_consent_at", null)` keeps it first-write-wins: a retry must not
  // move the timestamp off the moment consent was actually given.
  if (smsConsent === true) {
    const meta = buildSmsConsentMeta(req, language, groupId ? "group_booking" : "public_booking", {
      groupId,
      salonName: salon.name ?? "",
    });
    const patch = { sms_consent_at: new Date().toISOString(), sms_consent_meta: meta } as never;

    const { error: consentError } = await db
      .from("bookings")
      .update(patch)
      .eq("id", bookingId)
      .eq("salon_id", salonId)
      .is("sms_consent_at", null);

    if (consentError) {
      // Consent evidence is a compliance artifact — never let it fail silently.
      console.error("[sms-confirm] consent record write failed", {
        bookingId,
        groupId,
        error: consentError.message,
      });
      ErrorReporter.captureException(new Error(`sms_consent write failed: ${consentError.message}`), {
        tags: { area: "sms_consent" },
        extra: { bookingId, groupId, salonId },
      });
    }
  }

  // Defense-in-depth for the Twilio kill-switch: flag E2E/test salons so
  // sendSmsReminder suppresses real SMS even if a seed number ever slips past
  // the 555-exchange guard. E2E fixtures use slugs prefixed "e2e-" / names
  // starting "E2E " (e.g. "E2E Group Salon") — no real tenant does.
  const salonSlug = (salon as { slug?: string | null }).slug ?? "";
  const salonIsTest =
    /^e2e[-_]/i.test(salonSlug) || /^e2e\b/i.test(salon.name ?? "");

  // Language precedence: the language the customer just chose at booking wins;
  // else their stored preference for this salon; else the SALON's configured
  // notification locale.
  //
  // That last step used to be a hardcoded "vi", which is how a California salon
  // whose default_notification_locale is "en" ended up texting a customer in
  // Vietnamese: the voice widget passes the language of the browser session, so
  // one Vietnamese-speaking person testing the flow picked the language for a
  // customer base that does not read it. The salon's own setting is the only
  // sensible default when we know nothing about the individual customer.
  const salonLocale: "en" | "vi" =
    (salon as { default_notification_locale?: string | null }).default_notification_locale === "vi"
      ? "vi"
      : "en";
  const requestedLang = language === "en" || language === "vi" ? language : null;

  const { data: profile } = await db
    .from("client_profiles")
    .select("id, email")
    .eq("phone", clientPhone)
    .is("deleted_at", null)
    .maybeSingle();
  const clientEmailOnFile = (profile as { email?: string | null } | null)?.email?.trim() || null;

  let lang: "en" | "vi" = requestedLang ?? salonLocale;
  if (profile) {
    if (requestedLang) {
      // Persist the choice so future reminders for this customer match it.
      await db.from("customer_preferences").upsert(
        {
          client_profile_id: profile.id,
          salon_id: salonId,
          preferred_language: requestedLang,
        },
        { onConflict: "client_profile_id" },
      );
    } else {
      const { data: prefs } = await db
        .from("customer_preferences")
        .select("preferred_language")
        .eq("client_profile_id", profile.id)
        .eq("salon_id", salonId)
        .maybeSingle();
      lang = prefs?.preferred_language === "vi" || prefs?.preferred_language === "en"
        ? prefs.preferred_language
        : salonLocale;
    }
  }

  const salonTimezone = (salon as { timezone?: string | null }).timezone ?? "America/Vancouver";
  const dateStr = formatConfirmDate(startTimeUtc, salonTimezone);
  const name = clientName ?? "bạn";
  const salonName = salon.name ?? "";
  const staff = staffName ? ` with ${staffName}` : "";

  const baseMessage = isGroup
    ? lang === "en"
      ? `✅ Group of ${partySize} booked at ${salonName} · ${dateStr}. Reply STOP to opt out.`
      : `✅ Đã đặt lịch nhóm ${partySize} người tại ${salonName} · ${dateStr}. Nhắn STOP để huỷ nhận tin.`
    : lang === "en"
      ? `✅ Booked! ${serviceName}${staff} at ${salonName} · ${dateStr}. Reply STOP to opt out.`
      : `✅ Đã đặt lịch! ${serviceName} tại ${salonName} · ${dateStr}. Nhắn STOP để huỷ nhận tin.`;

  // Append the salon ADDRESS as plain text (not a long Google Maps URL): phones
  // auto-link a street address → tap opens the user's default maps app, and it's
  // far shorter than an encoded maps URL (saves an SMS segment). The full
  // "Get directions" Google button stays in the confirmation EMAIL.
  const salonAddress = (salon as { address?: string | null }).address?.trim() || "";
  const addrLine = salonAddress ? `\n📍 ${salonAddress}` : "";

  const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
  // Manage-booking link — lets the customer reschedule or cancel from the SMS
  // without hunting through email. Uses the /wait page which has Reschedule +
  // Cancel buttons. Only added for individual (non-group) bookings with a slug.
  const manageLink =
    salonSlug && bookingId && !isGroup
      ? `\nManage: ${SITE_URL}/${salonSlug}/wait/${bookingId}`
      : "";
  const message = baseMessage + addrLine + manageLink;
  const statusCallbackUrl = `${SITE_URL}/api/twilio/status`;
  // The salon-level switch is a hard operational kill-switch. Keep consent
  // evidence above, but do not call Twilio, stamp the booking as sent, or fan
  // out group-member texts while outbound SMS is disabled.
  const smsOutboundEnabled =
    (salon as { sms_outbound_enabled?: boolean | null }).sms_outbound_enabled !== false;
  const result = smsOutboundEnabled
    ? await sendSmsReminder(clientPhone, message, {
        statusCallbackUrl,
        salonIsTest,
        lang: lang === "en" ? "en" : "vi",
      })
    : { ok: true as const, error: undefined, messageSid: undefined };

  // Track on bookings row (legacy columns kept for now).
  // Awaited: a PostgrestBuilder only issues its request from `then()`, so the
  // `void`-ed form here never wrote — every one of these columns was NULL.
  if (smsOutboundEnabled) {
    const { error: trackError } = await db
      .from("bookings")
      .update(
        result.ok
          ? { sms_confirmation_sent_at: new Date().toISOString() }
          : {
              sms_confirmation_failed_at: new Date().toISOString(),
              sms_confirmation_error: result.error ?? "unknown",
            },
      )
      .eq("id", bookingId);
    if (trackError) console.error("[sms-confirm] sms_confirmation tracking write failed", trackError.message);
  }

  // Log to central notifications table
  if (smsOutboundEnabled) {
    void logNotification({
      bookingId,
      salonId,
      notificationType: "booking_confirmation",
      channel: "sms",
      clientPhone,
      messageSid: result.messageSid,
      bodyPreview: message,
      ok: result.ok,
      errorMessage: result.error,
    });
  }

  const emailOutboundEnabled = (salon as { email_outbound_enabled?: boolean | null }).email_outbound_enabled !== false;

  // Email confirmation — parallel channel when customer has an email on file
  // and the rich email wasn't already sent by submitPublicBooking (e.g. desk
  // bookings, or online bookings where the customer skipped the email field).
  // Best-effort: never blocks the SMS response.
  if (emailOutboundEnabled && clientEmailOnFile && !isGroup && serviceName && staffName) {
    void (async () => {
      // Only send if no email confirmation was logged yet for this booking.
      const { count } = await db
        .from("booking_notifications")
        .select("id", { count: "exact", head: true })
        .eq("booking_id", bookingId)
        .eq("notification_type", "booking_confirmation")
        .eq("channel", "email");
      if ((count ?? 0) === 0) {
        await sendBookingConfirmationEmail({
          bookingId,
          shopSlug: salonSlug,
          clientName: clientName ?? "Guest",
          clientEmail: clientEmailOnFile,
          serviceName: serviceName!,
          staffName: staffName!,
          startTimeUtc,
          totalPriceCents: null,
        });
      }
    })();
  }

  // ── Per-member SMS for group bookings ─────────────────────────────────────
  // Each non-organizer member gets a personal SMS with their slot details and
  // a unique RSVP link so they can confirm or decline attendance without
  // needing to contact the organizer.
  if (smsOutboundEnabled && isGroup && groupId) {
    void sendGroupMemberSms({
      db,
      groupId,
      organizerBookingId: bookingId,
      organizerName: clientName ?? "",
      salonName: salonName,
      salonSlug,
      salonTimezone,
      salonIsTest,
      salonId,
      lang,
    });
  }

  return NextResponse.json({ ok: result.ok, error: result.error });
}

async function sendGroupMemberSms(opts: {
  db: ReturnType<typeof createServiceRoleClient>;
  groupId: string;
  organizerBookingId: string;
  organizerName: string;
  salonName: string;
  salonSlug: string;
  salonTimezone: string;
  salonIsTest: boolean;
  salonId: string;
  /** Resolved by the caller (customer choice → stored pref → salon default).
   *  Everything below used to be hardcoded Vietnamese, so every guest of every
   *  party — including at English-speaking salons — got a Vietnamese text. */
  lang: "en" | "vi";
}) {
  const { db, groupId, organizerBookingId, organizerName, salonName, salonSlug, salonTimezone, salonIsTest, salonId, lang } = opts;

  try {
    // Fetch all non-organizer bookings in the group
    const { data: members } = await db
      .from("bookings" as never)
      .select("id, client_name, client_phone, service_name, staff_name, start_at")
      .eq("group_id", groupId)
      .neq("id", organizerBookingId);

    if (!members?.length) return;

    const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "https://nailiq.ca").trim();

    for (const raw of members) {
      const m = raw as {
        id: string;
        client_name: string | null;
        client_phone: string | null;
        service_name: string | null;
        staff_name: string | null;
        start_at: string;
      };
      if (!m.client_phone) continue;

      // Token expires at appointment time so RSVP is irrelevant after
      const tokenResult = await generateReminderToken(m.id, salonId, {
        expiresAt: m.start_at,
      });
      if (!tokenResult) continue;

      const dateStr = formatConfirmDate(m.start_at, salonTimezone);
      const staffPart = m.staff_name ? ` · ${m.staff_name}` : "";
      const rsvpUrl = `${SITE_URL}/booking/group-rsvp?token=${tokenResult.id}&lang=${lang}`;

      const msg = (lang === "en"
        ? [
            `${organizerName || "Your group"} booked an appointment for you at ${salonName} · ${dateStr}.`,
            m.service_name ? `Service: ${m.service_name}${staffPart}.` : null,
            `Confirm you're coming: ${rsvpUrl}`,
          ]
        : [
            `${organizerName || "Nhóm"} đã đặt lịch cho bạn tại ${salonName} · ${dateStr}.`,
            m.service_name ? `Dịch vụ: ${m.service_name}${staffPart}.` : null,
            `Xác nhận tham dự: ${rsvpUrl}`,
          ])
        .filter(Boolean)
        .join(" ");

      void sendSmsReminder(m.client_phone, msg, { salonIsTest, lang });
    }
  } catch {
    // Best-effort — don't fail the organizer SMS flow
  }
}
