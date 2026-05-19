import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { generateReminderToken } from "@/shared/noshow/generateReminderToken";
import { sendReminderEmail } from "@/shared/noshow/sendReminderEmail";

/** Vercel Cron calls this route every 15 minutes with the CRON_SECRET header. */
export const runtime = "nodejs";
export const maxDuration = 55;

type BookingRow = {
  id: string;
  salon_id: string;
  client_name: string;
  client_email: string | null;
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
  } | null;
};

export async function GET(req: Request) {
  // Validate Vercel Cron secret
  const cronSecret = (process.env.CRON_SECRET ?? "").trim();
  if (cronSecret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const supabase = createServiceRoleClient();
  const now = new Date();

  // 24 h window: 23h45m → 24h15m from now
  const window24hStart = new Date(now.getTime() + 23.75 * 60 * 60 * 1000).toISOString();
  const window24hEnd   = new Date(now.getTime() + 24.25 * 60 * 60 * 1000).toISOString();

  // 3 h window: 2h45m → 3h15m from now
  const window3hStart = new Date(now.getTime() + 2.75 * 60 * 60 * 1000).toISOString();
  const window3hEnd   = new Date(now.getTime() + 3.25 * 60 * 60 * 1000).toISOString();

  // Fetch bookings needing 24 h reminder
  const { data: need24h } = await supabase
    .from("bookings" as never)
    .select(`id, salon_id, client_name, client_email, start_time_utc,
             reminder_24h_sent_at, reminder_3h_sent_at,
             services(name), staff(name),
             salons(name, slug, reminders_enabled, reminder_24h_enabled, reminder_3h_enabled)`)
    .in("status", ["pending", "confirmed"])
    .gte("start_time_utc", window24hStart)
    .lte("start_time_utc", window24hEnd)
    .is("reminder_24h_sent_at", null)
    .not("client_email", "is", null);

  // Fetch bookings needing 3 h reminder
  const { data: need3h } = await supabase
    .from("bookings" as never)
    .select(`id, salon_id, client_name, client_email, start_time_utc,
             reminder_24h_sent_at, reminder_3h_sent_at,
             services(name), staff(name),
             salons(name, slug, reminders_enabled, reminder_24h_enabled, reminder_3h_enabled)`)
    .in("status", ["pending", "confirmed"])
    .gte("start_time_utc", window3hStart)
    .lte("start_time_utc", window3hEnd)
    .is("reminder_3h_sent_at", null)
    .not("client_email", "is", null);

  let sent24h = 0;
  let sent3h = 0;
  let errors = 0;

  async function processReminder(
    booking: BookingRow,
    reminderType: "24h" | "3h",
  ) {
    const salon = booking.salons;
    if (!salon?.reminders_enabled) return;
    if (reminderType === "24h" && !salon.reminder_24h_enabled) return;
    if (reminderType === "3h"  && !salon.reminder_3h_enabled)  return;
    if (!booking.client_email) return;

    const token = await generateReminderToken(booking.id, booking.salon_id);
    if (!token) { errors++; return; }

    const result = await sendReminderEmail({
      tokenId: token.id,
      clientName: booking.client_name,
      clientEmail: booking.client_email,
      serviceName: booking.services?.name ?? "appointment",
      staffName: booking.staff?.name ?? "",
      startTimeUtc: booking.start_time_utc,
      salonName: salon.name,
      salonSlug: salon.slug,
    });

    if (!result.ok) { errors++; return; }

    // Mark reminder as sent
    const col = reminderType === "24h" ? "reminder_24h_sent_at" : "reminder_3h_sent_at";
    await supabase
      .from("bookings" as never)
      .update({ [col]: new Date().toISOString() } as never)
      .eq("id", booking.id);

    if (reminderType === "24h") sent24h++;
    else sent3h++;
  }

  const tasks24h = ((need24h ?? []) as BookingRow[]).map((b) =>
    processReminder(b, "24h"),
  );
  const tasks3h = ((need3h ?? []) as BookingRow[]).map((b) =>
    processReminder(b, "3h"),
  );

  await Promise.allSettled([...tasks24h, ...tasks3h]);

  return NextResponse.json({
    ok: true,
    sent24h,
    sent3h,
    errors,
    processedAt: now.toISOString(),
  });
}
