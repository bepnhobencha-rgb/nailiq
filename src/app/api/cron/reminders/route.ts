import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { generateReminderToken } from "@/shared/noshow/generateReminderToken";
import { sendReminderEmail } from "@/shared/noshow/sendReminderEmail";
import { resolveVertical } from "@/shared/verticals/registry";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import { logNotification } from "@/shared/lib/notificationLog";
import { reminderLang, buildReminderSmsBody } from "@/shared/reminders/reminderSmsBody";
import { isUsPhone } from "@/shared/lib/phoneRegion";
import { sendGroupReminderEmail, type GroupMember } from "@/shared/noshow/sendReminderEmail";
import { isAiAgentPermissionEnabled } from "@/shared/ai/agentPermissionFence";
import { requireCronAuthorization } from "@/shared/security/cronAuthorization";
import { runTrackedCron } from "@/shared/security/cronRunHistory";

/** Vercel Cron calls this route every 15 minutes with the CRON_SECRET header. */
export const runtime = "nodejs";
export const maxDuration = 55;

const SITE_URL =
  (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";

type BookingRow = {
  id: string;
  salon_id: string;
  client_name: string;
  client_email: string | null;
  client_phone: string;
  start_time_utc: string;
  no_show_risk_score: number | null;
  client_locale: string | null;
  reminder_24h_sent_at: string | null;
  reminder_3h_sent_at: string | null;
  group_id: string | null;
  is_group_organizer: boolean | null;
  status: string;
  services: { name: string } | null;
  staff: { name: string } | null;
  salons: {
    name: string;
    slug: string;
    timezone: string | null;
    reminders_enabled: boolean;
    reminder_24h_enabled: boolean;
    reminder_3h_enabled: boolean;
    sms_reminders_enabled: boolean;
    sms_outbound_enabled: boolean | null;
    email_outbound_enabled: boolean | null;
    sms_a2p_registered: boolean | null;
    feature_flags: Record<string, unknown> | null;
  } | null;
};

function smsTimeLabel(booking: BookingRow): string {
  return new Date(booking.start_time_utc).toLocaleString("en-US", {
    timeZone: booking.salons?.timezone ?? "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** `aiLead`, when provided, replaces the fixed "Reminder: …" opening (the AI
 *  already weaves in service/salon/when/time). Links + STOP stay deterministic.
 *  Language follows the booking's client_locale (VI for vi* locales, else EN);
 *  copy lives in `@/shared/reminders/reminderSmsBody`. */
function buildSmsBody(
  booking: BookingRow,
  reminderType: "24h" | "3h",
  confirmUrl: string,
  rescheduleUrl: string,
  aiLead?: string | null,
): string {
  return buildReminderSmsBody({
    lang: reminderLang(booking.client_locale),
    reminderType,
    serviceName: booking.services?.name ?? "",
    salonName: booking.salons?.name ?? "",
    timeLabel: smsTimeLabel(booking),
    confirmUrl,
    rescheduleUrl,
    aiLead,
  });
}

export async function GET(req: Request) {
  const authorizationError = requireCronAuthorization(req);
  if (authorizationError) return authorizationError;
  return runTrackedCron("reminders", async () => {

  const supabase = createServiceRoleClient();
  const now = new Date();

  const window24hStart = new Date(now.getTime() + 23.75 * 60 * 60 * 1000).toISOString();
  const window24hEnd   = new Date(now.getTime() + 24.25 * 60 * 60 * 1000).toISOString();
  const window3hStart  = new Date(now.getTime() +  2.75 * 60 * 60 * 1000).toISOString();
  const window3hEnd    = new Date(now.getTime() +  3.25 * 60 * 60 * 1000).toISOString();

  const baseSelect = `id, salon_id, client_name, client_email, client_phone, start_time_utc,
    no_show_risk_score, client_locale, status,
    reminder_24h_sent_at, reminder_3h_sent_at,
    group_id, is_group_organizer,
    services!bookings_service_id_fkey(name), staff(name),
    salons(name, slug, timezone, vertical, reminders_enabled, reminder_24h_enabled, reminder_3h_enabled, sms_reminders_enabled, sms_outbound_enabled, email_outbound_enabled, sms_a2p_registered, feature_flags)`;

  // Fetch both email-eligible AND SMS-eligible bookings (no email filter here).
  const { data: need24h, error: err24h } = await supabase
    .from("bookings" as never)
    .select(baseSelect)
    .in("status", ["pending", "confirmed"])
    .gte("start_time_utc", window24hStart)
    .lte("start_time_utc", window24hEnd)
    .is("reminder_24h_sent_at", null);

  const { data: need3h, error: err3h } = await supabase
    .from("bookings" as never)
    .select(baseSelect)
    .in("status", ["pending", "confirmed"])
    .gte("start_time_utc", window3hStart)
    .lte("start_time_utc", window3hEnd)
    .is("reminder_3h_sent_at", null);

  // Surface a query failure instead of silently reporting a healthy run. A
  // dropped/renamed column in baseSelect (or any transient DB error) makes
  // `data` null; without this a totally broken reminder run returned
  // {ok:true, sent24h:0, sent3h:0} — indistinguishable from "nothing was due".
  if (err24h || err3h) {
    console.error("[reminders] query failed", err24h ?? err3h);
    return NextResponse.json({ ok: false, error: "query_failed" }, { status: 500 });
  }

  let sent24h = 0;
  let sent3h = 0;
  let errors = 0;

  /** Fetch all members of a group for the consolidated reminder. */
  async function fetchGroupMembers(groupId: string): Promise<GroupMember[]> {
    const { data, error } = await supabase
      .from("bookings" as never)
      .select("id, client_name, client_email, status, start_time_utc, services!bookings_service_id_fkey(name), staff(name)")
      .eq("group_id", groupId)
      .in("status", ["pending", "confirmed"])
      .order("start_time_utc");
    if (error) throw new Error("group_members_query_failed");
    return ((data ?? []) as {
      id: string;
      client_name: string;
      client_email: string | null;
      status: string;
      start_time_utc: string;
      services: { name: string } | null;
      staff: { name: string } | null;
    }[]).map((m) => ({
      name: m.client_name,
      serviceName: m.services?.name ?? "appointment",
      staffName: m.staff?.name ?? "",
      startTimeUtc: m.start_time_utc,
      status: m.status,
      email: m.client_email,
      bookingId: m.id,
    }));
  }

  /** Mark reminder sent for every member of a group (so they don't get individual emails later). */
  async function markGroupReminderSent(groupId: string, reminderType: "24h" | "3h") {
    const col = reminderType === "24h" ? "reminder_24h_sent_at" : "reminder_3h_sent_at";
    const { error } = await supabase
      .from("bookings" as never)
      .update({ [col]: new Date().toISOString() } as never)
      .eq("group_id", groupId)
      .in("status", ["pending", "confirmed"]);
    if (error) throw new Error("group_reminder_marker_failed");
  }

  async function processGroupReminder(booking: BookingRow, reminderType: "24h" | "3h") {
    const salon = booking.salons!;
    if (salon.email_outbound_enabled === false || !booking.client_email || !booking.group_id) return;

    const members = await fetchGroupMembers(booking.group_id);
    const { resolveVertical } = await import("@/shared/verticals/registry");

    const token = await generateReminderToken(booking.id, booking.salon_id);
    if (!token) { errors++; return; }

    const result = await sendGroupReminderEmail({
      tokenId: token.id,
      organizerName: booking.client_name,
      organizerEmail: booking.client_email,
      salonName: salon.name,
      salonSlug: salon.slug,
      reminderType,
      timezone: (salon as { timezone?: string | null }).timezone ?? null,
      businessDescriptor: resolveVertical((salon as { vertical?: string | null }).vertical).aiDescriptor,
      members,
    });

    void logNotification({
      bookingId: booking.id,
      salonId: booking.salon_id,
      notificationType: reminderType === "24h" ? "reminder_24h" : "reminder_3h",
      channel: "email",
      clientPhone: booking.client_phone ? `+${booking.client_phone}` : null,
      messageSid: result.messageId ?? null,
      bodyPreview: `Group reminder · party of ${members.length}`,
      ok: result.ok,
      errorMessage: result.error,
    });

    if (!result.ok) { errors++; return; }

    // Mark all group members as reminded so they don't receive individual emails
    await markGroupReminderSent(booking.group_id, reminderType);

    // Send individual reminder to members with their own distinct email
    for (const m of members) {
      if (!m.email || m.email === booking.client_email) continue;
      // The token MUST be bound to the member's OWN booking — the reminder email
      // renders confirm/reschedule/cancel buttons from it, so an organizer-bound
      // token let a member cancel/reschedule the ORGANIZER's appointment.
      if (!m.bookingId) continue;
      if (await import("@/shared/lib/emailCompliance").then((mod) => mod.isEmailSuppressed(m.email!))) continue;
      const { sendReminderEmail } = await import("@/shared/noshow/sendReminderEmail");
      const memberToken = await generateReminderToken(m.bookingId, booking.salon_id);
      if (!memberToken) continue;
      const memberResult = await sendReminderEmail({
        salonId: booking.salon_id,
        tokenId: memberToken.id,
        clientName: m.name,
        clientEmail: m.email,
        serviceName: m.serviceName,
        staffName: m.staffName,
        startTimeUtc: m.startTimeUtc,
        salonName: salon.name,
        salonSlug: salon.slug,
        timezone: (salon as { timezone?: string | null }).timezone ?? null,
        businessDescriptor: resolveVertical((salon as { vertical?: string | null }).vertical).aiDescriptor,
      });
      void logNotification({
        bookingId: m.bookingId,
        salonId: booking.salon_id,
        notificationType: reminderType === "24h" ? "reminder_24h" : "reminder_3h",
        channel: "email",
        messageSid: memberResult.messageId ?? null,
        bodyPreview: "Group member reminder",
        ok: memberResult.ok,
        errorMessage: memberResult.error,
      });
    }

    if (reminderType === "24h") sent24h++; else sent3h++;
  }

  async function processReminder(booking: BookingRow, reminderType: "24h" | "3h") {
    const salon = booking.salons;
    if (!salon?.reminders_enabled) return;
    if (reminderType === "24h" && !salon.reminder_24h_enabled) return;
    if (reminderType === "3h"  && !salon.reminder_3h_enabled)  return;

    // Group member (non-organizer): skip — handled via organizer's group email
    if (booking.group_id && !booking.is_group_organizer) return;

    // Group organizer: send consolidated group email
    if (booking.group_id && booking.is_group_organizer) {
      await processGroupReminder(booking, reminderType);
      return;
    }

    const wantsEmail = salon.email_outbound_enabled !== false && !!booking.client_email;
    const smsA2pRegistered = salon.sms_a2p_registered === true; // fail-safe: only an explicit true (A2P approved) permits US link-SMS; NULL/false → email-links mitigation
    let wantsSms   = salon.sms_outbound_enabled !== false && salon.sms_reminders_enabled && !!booking.client_phone;
    // A2P 10DLC guardrail: US numbers require A2P registration; skip SMS if not registered.
    if (wantsSms && isUsPhone(booking.client_phone) && !smsA2pRegistered) {
      wantsSms = false;
      void logNotification({
        bookingId: booking.id,
        salonId: booking.salon_id,
        notificationType: reminderType === "24h" ? "reminder_24h" : "reminder_3h",
        channel: "sms",
        clientPhone: `+${booking.client_phone}`,
        ok: false,
        errorMessage: "a2p_not_registered",
      });
    }

    if (!wantsEmail && !wantsSms) return;

    const token = await generateReminderToken(booking.id, booking.salon_id);
    if (!token) { errors++; return; }

    let anySuccess = false;

    // Email channel
    if (wantsEmail) {
      const result = await sendReminderEmail({
        salonId:      booking.salon_id,
        tokenId:      token.id,
        clientName:   booking.client_name,
        clientEmail:  booking.client_email!,
        serviceName:  booking.services?.name ?? "appointment",
        staffName:    booking.staff?.name ?? "",
        startTimeUtc: booking.start_time_utc,
        salonName:    salon.name,
        salonSlug:    salon.slug,
        timezone:     (salon as { timezone?: string | null }).timezone ?? null,
        businessDescriptor: resolveVertical(
          (salon as { vertical?: string | null }).vertical,
        ).aiDescriptor,
      });
      void logNotification({
        bookingId: booking.id,
        salonId: booking.salon_id,
        notificationType: reminderType === "24h" ? "reminder_24h" : "reminder_3h",
        channel: "email",
        messageSid: result.messageId ?? null,
        bodyPreview: `Reminder email · ${booking.services?.name ?? "appointment"}`,
        ok: result.ok,
        errorMessage: result.error,
      });
      if (result.ok) anySuccess = true;
      else errors++;
    }

    // SMS channel
    if (wantsSms) {
      const confirmUrl = `${SITE_URL}/booking/confirm?token=${token.id}`;
      const rescheduleUrl = `${SITE_URL}/booking/reschedule?token=${token.id}`;
      const toE164 = `+${booking.client_phone}`;

      // Smart reminder: AI personalises the lead line (tone adapts to no-show
      // risk), gated on the salon's ai_smart_reminders opt-in. Guarded + falls
      // back to the fixed template. Links + STOP stay deterministic.
      let aiLead: string | null = null;
      if (
        (salon.feature_flags as Record<string, unknown> | null)
          ?.ai_smart_reminders === true &&
        (await isAiAgentPermissionEnabled(
          booking.salon_id,
          "ai_smart_reminders",
        ))
      ) {
        try {
          const { draftReminderLead, guardReminderLead } = await import(
            "@/shared/reminders/agentSmartReminder"
          );
          const lang: "en" | "vi" = String(booking.client_locale ?? "").toLowerCase().startsWith("vi") ? "vi" : "en";
          const drafted = await draftReminderLead({
            salonId: booking.salon_id,
            clientName: booking.client_name ?? "",
            serviceName: booking.services?.name ?? "appointment",
            salonName: salon.name ?? "",
            whenLabel: reminderType === "24h" ? "tomorrow" : "in 3 hours",
            timeLabel: smsTimeLabel(booking),
            riskScore: booking.no_show_risk_score,
            lang,
          });
          if (drafted) aiLead = guardReminderLead(drafted, salon.name ?? "");
        } catch {
          /* keep the fixed template */
        }
      }

      const body   = buildSmsBody(booking, reminderType, confirmUrl, rescheduleUrl, aiLead);
      const statusCallbackUrl = `${SITE_URL}/api/twilio/status`;
      const result = await sendSmsReminder(toE164, body, { statusCallbackUrl });
      if (result.ok) anySuccess = true;
      else errors++;
      void logNotification({
        bookingId: booking.id,
        salonId: booking.salon_id,
        notificationType: reminderType === "24h" ? "reminder_24h" : "reminder_3h",
        channel: "sms",
        clientPhone: toE164,
        messageSid: result.messageSid,
        bodyPreview: body,
        ok: result.ok,
        errorMessage: result.error,
      });
    }

    if (!anySuccess) return;

    const col = reminderType === "24h" ? "reminder_24h_sent_at" : "reminder_3h_sent_at";
    const { error: markerError } = await supabase
      .from("bookings" as never)
      .update({ [col]: new Date().toISOString() } as never)
      .eq("id", booking.id);
    if (markerError) throw new Error("reminder_marker_failed");

    if (reminderType === "24h") sent24h++;
    else sent3h++;
  }

  const tasks24h = ((need24h ?? []) as BookingRow[]).map((b) => processReminder(b, "24h"));
  const tasks3h  = ((need3h  ?? []) as BookingRow[]).map((b) => processReminder(b, "3h"));

  const taskResults = await Promise.allSettled([...tasks24h, ...tasks3h]);
  const taskFailures = taskResults.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  ).length;
  if (taskFailures > 0) {
    // Keep the worker heartbeat honest without logging rejection reasons that
    // may contain customer/provider data. Explicit channel failures are already
    // included in `errors`; unexpected task exceptions are counted separately.
    console.error("[reminders] processing failures", { taskFailures });
    return NextResponse.json(
      {
        ok: false,
        error: "processing_failed",
        sent24h,
        sent3h,
        errors: errors + taskFailures,
        processedAt: now.toISOString(),
      },
      { status: 500 },
    );
  }

    return NextResponse.json({ ok: true, sent24h, sent3h, errors, processedAt: now.toISOString() });
  });
}
