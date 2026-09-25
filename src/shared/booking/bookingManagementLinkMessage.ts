/** Presentation only: an unusable capability never proves a booking outcome. */
export function bookingManagementLinkMessage(code: string): { title: string; message: string } {
  switch (code) {
    case "token_consumed":
      return { title: "Link already used", message: "This link has already been used. Check your latest appointment message or contact the salon to confirm its current status. / Liên kết đã được sử dụng. Hãy xem thông báo lịch hẹn mới nhất hoặc liên hệ tiệm để kiểm tra trạng thái hiện tại." };
    case "stale_booking":
    case "stale_policy":
    case "stale_party":
      return { title: "Appointment details have changed", message: "Use the link in your latest appointment message, or contact the salon. / Thông tin lịch hẹn đã thay đổi. Vui lòng dùng liên kết trong thông báo mới nhất hoặc liên hệ tiệm." };
    case "expired_or_revoked":
    case "token_invalid":
      return { title: "Link no longer available", message: "This link has expired or is no longer valid. Open your latest appointment message or contact the salon. / Liên kết đã hết hạn hoặc không còn hiệu lực. Hãy mở thông báo lịch hẹn mới nhất hoặc liên hệ tiệm." };
    case "missing_token":
    case "invalid_token":
    case "action_mismatch":
      return { title: "Check your appointment link", message: "Open the complete link from your appointment message. If it still does not work, contact the salon. / Hãy mở liên kết đầy đủ trong thông báo lịch hẹn. Nếu vẫn không mở được, vui lòng liên hệ tiệm." };
    case "rate_limited":
      return { title: "Please wait a moment", message: "Too many attempts. Wait a few minutes before trying again. / Bạn đã thử nhiều lần. Vui lòng đợi vài phút rồi thử lại." };
    case "already_confirmed":
      return { title: "Appointment already confirmed", message: "This appointment is already confirmed. Contact the salon if you need to make a change. / Lịch hẹn đã được xác nhận. Liên hệ tiệm nếu bạn cần thay đổi." };
    default:
      return { title: "Unable to check this appointment", message: "We could not verify the current appointment status. Please contact the salon before trying again. / Chưa thể kiểm tra trạng thái lịch hẹn hiện tại. Vui lòng liên hệ tiệm trước khi thử lại." };
  }
}
