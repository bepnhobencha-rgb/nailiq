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
import { buildBookingChangeSms } from "@/shared/lib/smsTemplateRegistry";

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
  /** New provider name for a staff-only reassignment. */
  staffName?: string | null;
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
  return buildBookingChangeSms({
    event,
    lang: locale,
    salonName: v.salonName,
    serviceName: v.serviceName,
    whenLabel: v.whenLabel,
    customerName: v.customerName,
    staffName: v.staffName,
    salonPhone: v.salonPhone,
  });
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
      case "staff_change":
        return `Cập nhật nhân viên phục vụ — ${salon}`;
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
    case "staff_change":
      return `Appointment provider updated — ${salon}`;
  }
}
