import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { generateReminderToken } from "@/shared/noshow/generateReminderToken";
import { sendReminderEmail } from "@/shared/noshow/sendReminderEmail";
import { sendSmsReminder } from "@/shared/lib/twilioSms";

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
  reminder_24h_sent_at: string | null;
  reminder_3h_sent_at: string | null;
  services: { name: string } | null;
  staff: { name: string } | null;
  salons: {
    name: string;
    slug: string;
    reminders_enabled: boolean;
    reminder_24h_enabled: boolean;
    reminder_3h_enabled: boolean;
    sms_reminders_enabled: boolean;
  } | null;
};

function buildSmsBody(
  booking: BookingRow,
  reminderType: "24h" | "3h",
  confirmUrl: string,
): string {
  const when = reminderType === "24h" ? "tomorrow" : "in 3 hours";
  const time = new Date(booking.start_time_utc).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const service = booking.services?.name ?? "appointment";
  const salon = booking.salons?.name ?? "";
  // Keep under 160 chars so it's one SMS segment.
  return `Reminder: Your ${service} at ${salon} is ${when} at ${time}. Confirm: ${confirmUrl} · Reply STOP to opt out.`;
}

export async function GET(req: Request) {
  const cronSecret = (process.env.CRON_SECRET ?? "").trim();
  if (cronSecret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const supabase = createServiceRoleClient();
  const now = new Date();

  const window24hStart = new Date(now.getTime() + 23.75 * 60 * 60 * 1000).toISOString();
  const window24hEnd   = new Date(now.getTime() + 24.25 * 60 * 60 * 1000).toISOString();
  const window3hStart  = new Date(now.getTime() +  2.75 * 60 * 60 * 1000).toISOString();
  const window3hEnd    = new Date(now.getTime() +  3.25 * 60 * 60 * 1000).toISOString();

  const baseSelect = `id, salon_id, client_name, client_email, client_phone, start_time_utc,
    reminder_24h_sent_at, reminder_3h_sent_at,
    services!bookings_service_id_fkey(name), staff(name),
    salons(name, slug, reminders_enabled, reminder_24h_enabled, reminder_3h_enabled, sms_reminders_enabled)`;

  // Fetch both email-eligible AND SMS-eligible bookings (no email filter here).
  const { data: need24h } = await supabase
    .from("bookings" as never)
    .select(baseSelect)
    .in("status", ["pending", "confirmed"])
    .gte("start_time_utc", window24hStart)
    .lte("start_time_utc", window24hEnd)
    .is("reminder_24h_sent_at", null);

  const { data: need3h } = await supabase
    .from("bookings" as never)
    .select(baseSelect)
    .in("status", ["pending", "confirmed"])
    .gte("start_time_utc", window3hStart)
    .lte("start_time_utc", window3hEnd)
    .is("reminder_3h_sent_at", null);

  let sent24h = 0;
  let sent3h = 0;
  let errors = 0;

  async function processReminder(booking: BookingRow, reminderType: "24h" | "3h") {
    const salon = booking.salons;
    if (!salon?.reminders_enabled) return;
    if (reminderType === "24h" && !salon.reminder_24h_enabled) return;
    if (reminderType === "3h"  && !salon.reminder_3h_enabled)  return;

    const wantsEmail = !!booking.client_email;
    const wantsSms   = salon.sms_reminders_enabled && !!booking.client_phone;

    if (!wantsEmail && !wantsSms) return;

    const token = await generateReminderToken(booking.id, booking.salon_id);
    if (!token) { errors++; return; }

    let anySuccess = false;

    // Email channel
    if (wantsEmail) {
      const result = await sendReminderEmail({
        tokenId:      token.id,
        clientName:   booking.client_name,
        clientEmail:  booking.client_email!,
        serviceName:  booking.services?.name ?? "appointment",
        staffName:    booking.staff?.name ?? "",
        startTimeUtc: booking.start_time_utc,
        salonName:    salon.name,
        salonSlug:    salon.slug,
      });
      if (result.ok) anySuccess = true;
      else errors++;
    }

    // SMS channel
    if (wantsSms) {
      const confirmUrl = `${SITE_URL}/booking/confirm?token=${token.id}`;
      const toE164 = `+${booking.client_phone}`;
      const body   = buildSmsBody(booking, reminderType, confirmUrl);
      const result = await sendSmsReminder(toE164, body);
      if (result.ok) anySuccess = true;
      else errors++;
    }

    if (!anySuccess) return;

    const col = reminderType === "24h" ? "reminder_24h_sent_at" : "reminder_3h_sent_at";
    await supabase
      .from("bookings" as never)
      .update({ [col]: new Date().toISOString() } as never)
      .eq("id", booking.id);

    if (reminderType === "24h") sent24h++;
    else sent3h++;
  }

  const tasks24h = ((need24h ?? []) as BookingRow[]).map((b) => processReminder(b, "24h"));
  const tasks3h  = ((need3h  ?? []) as BookingRow[]).map((b) => processReminder(b, "3h"));

  await Promise.allSettled([...tasks24h, ...tasks3h]);

  return NextResponse.json({ ok: true, sent24h, sent3h, errors, processedAt: now.toISOString() });
}
