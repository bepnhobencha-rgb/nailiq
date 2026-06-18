// Pure, dependency-free builder for the appointment-reminder SMS body.
//
// Extracted from the reminders cron route so the copy is unit-testable and so
// the Vietnamese + English variants live in one place. The cron route stamps
// `bookings.client_locale` from the language the customer chose at booking
// (see publicBookingSideEffects / submitGroupBooking), so a VI customer gets a
// VI reminder and everyone else gets EN (the safe default).

export type ReminderLang = "en" | "vi";

/** Resolve the reminder language from a booking's stored client_locale.
 *  Anything that isn't an explicit "vi*" locale falls back to English. */
export function reminderLang(clientLocale: string | null | undefined): ReminderLang {
  return String(clientLocale ?? "").toLowerCase().startsWith("vi") ? "vi" : "en";
}

export type ReminderSmsInput = {
  lang: ReminderLang;
  reminderType: "24h" | "3h";
  serviceName: string;
  salonName: string;
  /** Localised time label, e.g. "9:00 AM" (already formatted in salon tz). */
  timeLabel: string;
  confirmUrl: string;
  rescheduleUrl: string;
  /** When provided (AI smart reminder), replaces the fixed lead line. The
   *  static footer (links + STOP) is still localised by `lang`. */
  aiLead?: string | null;
};

/**
 * Build the full reminder SMS body, including the confirm/reschedule links and
 * the carrier-required opt-out line, in the customer's language.
 */
export function buildReminderSmsBody(input: ReminderSmsInput): string {
  const { lang, reminderType, salonName, timeLabel, confirmUrl, rescheduleUrl, aiLead } = input;

  if (lang === "vi") {
    const service = input.serviceName?.trim() || "lịch hẹn";
    const when = reminderType === "24h" ? "vào ngày mai" : "trong 3 giờ nữa";
    const lead = aiLead || `Nhắc lịch: ${service} tại ${salonName} ${when} lúc ${timeLabel}.`;
    return `${lead}\nXác nhận: ${confirmUrl}\nĐổi lịch: ${rescheduleUrl}\nNhắn STOP để huỷ nhận tin.`;
  }

  const service = input.serviceName?.trim() || "appointment";
  const when = reminderType === "24h" ? "tomorrow" : "in 3 hours";
  const lead = aiLead || `Reminder: Your ${service} at ${salonName} is ${when} at ${timeLabel}.`;
  return `${lead}\nConfirm: ${confirmUrl}\nReschedule: ${rescheduleUrl}\nReply STOP to opt out.`;
}
