/**
 * Customer-facing message bodies for STAFF-initiated booking actions
 * (create / reschedule / cancel), in English + Vietnamese. Pure string
 * builders — no I/O — so they're unit-testable and reusable by both the SMS
 * sender and the live preview the receptionist sees before sending.
 *
 * Language is resolved upstream (`resolveCustomerLocale`): online bookings keep
 * the customer's site language; staff/desk actions default to English.
 */

import type { SupportedLocale } from "./resolveCustomerLocale";
import type { StaffNotifyEvent } from "@/shared/dashboard/staffNotificationSettings";

export interface StaffActionMessageVars {
  /** Customer first name (already display-safe). Empty string is fine. */
  customerName: string;
  salonName: string;
  serviceName: string;
  /** Appointment time, already formatted in the salon timezone + the target
   *  locale, e.g. "Sat, Jun 14 at 2:00 PM" / "Th 7, 14 thg 6 lúc 2:00 CH". */
  whenLabel: string;
  /** Salon phone for "call us" lines. Optional. */
  salonPhone?: string | null;
}

function greet(name: string, locale: SupportedLocale): string {
  const n = name.trim();
  if (locale === "vi") return n ? `Chào ${n}, ` : "";
  return n ? `Hi ${n}, ` : "";
}

function callLine(phone: string | null | undefined, locale: SupportedLocale): string {
  const p = (phone ?? "").trim();
  if (!p) return "";
  return locale === "vi" ? ` Cần đổi? Gọi ${p}.` : ` Questions? Call ${p}.`;
}

/**
 * Build the SMS body for a staff-initiated action in the given locale.
 * `event` "no_show" has no customer SMS (handled by win-back elsewhere) and
 * returns null.
 */
export function buildStaffActionSms(
  event: StaffNotifyEvent,
  locale: SupportedLocale,
  v: StaffActionMessageVars,
): string | null {
  const salon = v.salonName.trim() || "NailIQ";
  const svc = v.serviceName.trim();
  const g = greet(v.customerName, locale);
  const call = callLine(v.salonPhone, locale);

  if (locale === "vi") {
    switch (event) {
      case "create":
        return `${g}lịch hẹn ${svc} của bạn tại ${salon} đã được đặt: ${v.whenLabel}.${call}`.trim();
      case "reschedule":
        return `${g}lịch hẹn ${svc} của bạn tại ${salon} đã được dời sang: ${v.whenLabel}.${call}`.trim();
      case "cancel":
        return `${g}lịch hẹn ${svc} của bạn tại ${salon} (${v.whenLabel}) đã được huỷ.${call}`.trim();
      case "no_show":
        return null;
    }
  }

  switch (event) {
    case "create":
      return `${g}your ${svc} appointment at ${salon} is booked for ${v.whenLabel}.${call}`.trim();
    case "reschedule":
      return `${g}your ${svc} appointment at ${salon} has been moved to ${v.whenLabel}.${call}`.trim();
    case "cancel":
      return `${g}your ${svc} appointment at ${salon} (${v.whenLabel}) has been cancelled.${call}`.trim();
    case "no_show":
      return null;
  }
}

/** Short subject line for the email channel. */
export function buildStaffActionEmailSubject(
  event: StaffNotifyEvent,
  locale: SupportedLocale,
  salonName: string,
): string | null {
  const salon = salonName.trim() || "NailIQ";
  if (locale === "vi") {
    switch (event) {
      case "create":
        return `Xác nhận lịch hẹn — ${salon}`;
      case "reschedule":
        return `Lịch hẹn đã được dời — ${salon}`;
      case "cancel":
        return `Lịch hẹn đã huỷ — ${salon}`;
      case "no_show":
        return null;
    }
  }
  switch (event) {
    case "create":
      return `Appointment confirmed — ${salon}`;
    case "reschedule":
      return `Appointment rescheduled — ${salon}`;
    case "cancel":
      return `Appointment cancelled — ${salon}`;
    case "no_show":
      return null;
  }
}
