// Pure, dependency-free builder for the appointment-reminder SMS body.
//
// Extracted from the reminders cron route so the copy is unit-testable and so
// the Vietnamese + English variants live in one place. The cron route stamps
// `bookings.client_locale` from the language the customer chose at booking
// (see publicBookingSideEffects / submitGroupBooking), so a VI customer gets a
// VI reminder and everyone else gets EN (the safe default).

import { buildReminderSms } from "@/shared/lib/smsTemplateRegistry";

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
  return buildReminderSms(input);
}
