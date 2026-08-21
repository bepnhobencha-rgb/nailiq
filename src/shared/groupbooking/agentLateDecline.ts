/**
 * Minh agent: handles late group decline events logged to ai_actions_log.
 * Triggered fire-and-forget from reportLateDecline server action.
 *
 * Responsibilities:
 *   1. Dedup — skip if already handled for this booking
 *   2. SMS suggested replacement (if organizer provided one)
 *   3. Notify top waitlisted person for this date/salon
 *   4. Log outcome back to ai_actions_log
 */

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { sendSmsReminder } from "@/shared/lib/twilioSms";

const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "https://nailiq.ca").trim();

type LateDeclinePayload = {
  booking_id: string;
  group_id: string | null;
  member_name: string | null;
  service_name: string | null;
  start_at: string;
  suggested_name: string | null;
  suggested_phone: string | null;
};

export async function handleLateDecline(
  salonId: string,
  payload: LateDeclinePayload,
): Promise<void> {
  const db = createServiceRoleClient();

  // 1. Dedup — if Minh already handled this booking, bail
  const { count } = await db
    .from("ai_actions_log" as never)
    .select("id", { count: "exact", head: true })
    .eq("agent", "minh_late_decline")
    .eq("action_type", "late_decline_handled")
    .eq("target_id", payload.booking_id);
  if ((count ?? 0) > 0) return;

  // 2. Check appointment is still in the future (nothing to do if already passed)
  if (new Date(payload.start_at) < new Date()) {
    void logHandled(db, salonId, payload.booking_id, { outcome: "appointment_passed" });
    return;
  }

  // 3. Load salon info for slug + timezone + isTest guard
  const { data: salon } = await db
    .from("salons" as never)
    .select("name, slug, timezone")
    .eq("id", salonId)
    .maybeSingle();

  const s = salon as { name: string; slug: string; timezone: string } | null;
  if (!s) return;

  const salonIsTest = /^e2e[-_]/i.test(s.slug) || /^e2e\b/i.test(s.name ?? "");
  const bookingUrl = `${SITE_URL}/${s.slug}`;

  // Format date in salon timezone (short, ASCII-safe for SMS)
  const dateStr = formatDate(payload.start_at, s.timezone);
  const service = payload.service_name ?? "dịch vụ";

  const outcomes: string[] = [];

  // 4. SMS suggested replacement first (highest intent — someone specific was named)
  if (payload.suggested_phone) {
    const msg = [
      `${payload.suggested_name ? payload.suggested_name + ", b" : "B"}ạn được đề xuất thay thế một slot nhóm tại ${s.name} · ${dateStr}.`,
      `Dịch vụ: ${service}.`,
      `Đặt lịch ngay (first-come): ${bookingUrl}`,
    ].join(" ");

    const res = await sendSmsReminder(payload.suggested_phone, msg, {
      salonId,
      salonIsTest,
      lang: "vi",
    });
    outcomes.push(res.ok ? `sms_suggested:ok` : `sms_suggested:fail`);
  }

  // 5. Notify top waitlisted person for this salon + date
  const localDate = toLocalDate(payload.start_at, s.timezone);
  const waitlistNotified = await notifyTopWaitlist(db, salonId, localDate, s, dateStr, service, salonIsTest);
  outcomes.push(waitlistNotified ? "sms_waitlist:ok" : "sms_waitlist:none");

  // 6. Log outcome
  void logHandled(db, salonId, payload.booking_id, { outcome: outcomes.join("|") });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function notifyTopWaitlist(
  db: ReturnType<typeof createServiceRoleClient>,
  salonId: string,
  localDate: string,
  salon: { name: string; slug: string },
  dateStr: string,
  service: string,
  salonIsTest: boolean,
): Promise<boolean> {
  // Find top pending waitlist entry for this salon + date
  const { data: entries } = await db
    .from("booking_waitlist_entries" as never)
    .select("id, client_name, client_phone, status")
    .eq("salon_id", salonId)
    .eq("booking_date", localDate)
    .or("status.is.null,status.eq.waiting")
    .order("created_at", { ascending: true })
    .limit(1);

  const top = (entries as Array<{ id: string; client_name: string; client_phone: string }> | null)?.[0];
  if (!top?.client_phone) return false;

  const name = top.client_name ?? "";
  const msg = [
    `${name ? name + ", c" : "C"}ó một slot vừa mở tại ${salon.name} · ${dateStr}.`,
    `Dịch vụ: ${service}.`,
    `Đặt ngay (first-come): ${SITE_URL}/${salon.slug}`,
  ].join(" ");

  const res = await sendSmsReminder(top.client_phone, msg, {
    salonId,
    salonIsTest,
    lang: "vi",
  });

  // Mark as notified so the next dedup pass skips this entry
  if (res.ok) {
    // Awaited — `void` on a PostgrestBuilder never issued the request, so the
    // dedup pass never saw "notified" and could re-notify the same entry.
    await db
      .from("booking_waitlist_entries" as never)
      .update({ status: "notified", notified_at: new Date().toISOString() } as never)
      .eq("id", top.id);
  }

  return res.ok;
}

async function logHandled(
  db: ReturnType<typeof createServiceRoleClient>,
  salonId: string,
  bookingId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.from("ai_actions_log" as never).insert({
    salon_id: salonId,
    agent: "minh_late_decline",
    action_type: "late_decline_handled",
    target_id: bookingId,
    payload,
  } as never);
}

function formatDate(isoUtc: string, timezone: string): string {
  try {
    return new Date(isoUtc).toLocaleString("vi-VN", {
      weekday: "short",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
    });
  } catch {
    return isoUtc;
  }
}

function toLocalDate(isoUtc: string, timezone: string): string {
  try {
    // Returns YYYY-MM-DD in salon's local timezone
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone })
      .format(new Date(isoUtc));
  } catch {
    return isoUtc.slice(0, 10);
  }
}
