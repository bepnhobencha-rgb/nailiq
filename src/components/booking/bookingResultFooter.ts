/**
 * Pure helper that picks the footer note shown on the Voice AI booking-result
 * card. Extracted from VoiceBookingModal so the SMS-truthfulness rule is
 * unit-testable without driving the live voice modal (mic + WebSocket).
 *
 * Rule: for a NEW booking, only claim "Confirmation SMS sent" when the backend
 * actually confirmed the send (`smsSent === true`). Otherwise — provider
 * disabled, not configured, invalid phone, or send failure — show a neutral
 * message that does NOT claim an SMS was sent.
 */

export type BookingResultAction = "booked" | "rescheduled" | "cancelled";

export function bookingResultFooterNote(
  args: { action: BookingResultAction; smsSent?: boolean },
  language: "en" | "vi",
): string {
  const vi = language === "vi";

  if (args.action === "cancelled") {
    return vi ? "✓ Lịch hẹn đã được huỷ" : "✓ Appointment removed from schedule";
  }
  if (args.action === "rescheduled") {
    return vi ? "📅 Lịch hẹn đã được cập nhật" : "📅 Schedule updated";
  }

  // action === "booked"
  if (args.smsSent === true) {
    return vi ? "📱 Tin nhắn xác nhận đã được gửi" : "📱 Confirmation SMS sent";
  }
  return vi
    ? "✓ Đã đặt lịch. Không gửi được tin nhắn xác nhận."
    : "✓ Booking confirmed. SMS confirmation could not be sent.";
}
