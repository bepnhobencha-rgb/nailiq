export type GroupRecoveryLanguage = "en" | "vi";

const en = {
  title: "Take this group appointment",
  intro: "Keep the same service and appointment time. The rest of the group stays unchanged.",
  servicePrice: "Service price",
  salonTime: "Salon time",
  expires: "Link expires",
  name: "Your full name",
  phone: "Your phone number",
  agreement: "I accept this service, price and appointment time. These are my contact details.",
  noCardTransfer: "No payment is taken here. The previous guest’s saved card and consent are not transferred to you.",
  accept: "Confirm my place",
  checking: "Checking your confirmation…",
  accepted: "Place confirmed",
  acceptedBody: "The replacement is complete. The other group appointments are unchanged. No cancellation fee was collected by this action.",
  alreadyAcceptedBody: "This replacement has already been completed. This link cannot reserve another place.",
  invalidName: "Enter your full name using letters, numbers, spaces, apostrophes or hyphens.",
  differentGuest: "The replacement must use their own contact details, different from the guest leaving this place.",
  invalidPhone: "Enter a valid phone number, including country code if needed.",
  consentRequired: "Please confirm the service and appointment details before continuing.",
  unavailable: "This replacement link is unavailable. Ask the person who shared it or contact the salon.",
  expired: "This link has expired. Contact the salon for help; no new appointment was created by this attempt.",
  changed: "The appointment has changed or can no longer be replaced. Contact the salon before making another booking.",
  cardRequired: "This appointment needs a new card agreement. Contact the salon to arrange a replacement safely.",
  error: "We could not check the result. Use the same confirmation again to check it safely; do not create another booking.",
  retry: "Check the same confirmation",
  senderTitle: "Ask someone to take your place",
  senderIntro: "Create a private link for one replacement guest, keeping the same service and time.",
  senderRule: "Your place remains reserved until the replacement is confirmed. Creating or sharing a link does not cancel your appointment or waive a fee.",
  create: "Create replacement link",
  pending: "Waiting for a replacement",
  complete: "Replacement confirmed",
  completeBody: "Your replacement has been confirmed. The rest of the group keeps their appointments.",
  revoke: "Stop sharing this place",
  revoked: "The replacement link is closed. Your appointment is still reserved.",
  recoverLink: "Show the existing private link",
  copy: "Copy private link",
  copied: "Link copied",
  copyFallback: "Copy the link from the field below. Share it only with the person taking your place.",
  shareHint: "Share this link yourself. NailIQ has not sent an email or text message.",
  refresh: "Refresh status",
  loading: "Checking replacement options…",
  senderError: "We could not check replacement options. Try again or contact the salon. Your appointment has not been cancelled by this action.",
  noReplacement: "An online replacement is not available for this appointment. Contact the salon for help.",
  linkLabel: "Private replacement link",
};

const vi: typeof en = {
  title: "Nhận chỗ hẹn trong nhóm",
  intro: "Giữ nguyên dịch vụ và giờ hẹn. Lịch của các thành viên còn lại không thay đổi.",
  servicePrice: "Giá dịch vụ",
  salonTime: "Giờ của salon",
  expires: "Link hết hạn",
  name: "Họ tên của bạn",
  phone: "Số điện thoại của bạn",
  agreement: "Tôi đồng ý với dịch vụ, giá và giờ hẹn này. Đây là thông tin liên hệ của tôi.",
  noCardTransfer: "Không thu tiền tại bước này. Thẻ đã lưu và sự đồng ý của khách trước không được chuyển sang bạn.",
  accept: "Xác nhận nhận chỗ",
  checking: "Đang kiểm tra xác nhận…",
  accepted: "Đã xác nhận chỗ hẹn",
  acceptedBody: "Đã hoàn tất thay người. Lịch của các thành viên khác không thay đổi. Thao tác này không thu phí hủy.",
  alreadyAcceptedBody: "Chỗ này đã được thay người thành công. Link này không thể đặt thêm chỗ.",
  invalidName: "Nhập họ tên hợp lệ bằng chữ, số, khoảng trắng, dấu nháy hoặc gạch nối.",
  differentGuest: "Người thay cần dùng thông tin liên hệ của mình, khác với khách nhường chỗ.",
  invalidPhone: "Nhập số điện thoại hợp lệ, kèm mã quốc gia nếu cần.",
  consentRequired: "Vui lòng xác nhận dịch vụ và thông tin lịch hẹn trước khi tiếp tục.",
  unavailable: "Link thay người không còn khả dụng. Hãy hỏi người gửi link hoặc liên hệ salon.",
  expired: "Link đã hết hạn. Liên hệ salon để được hỗ trợ; lần thử này không tạo lịch hẹn mới.",
  changed: "Lịch hẹn đã thay đổi hoặc không còn được thay người. Liên hệ salon trước khi đặt lịch khác.",
  cardRequired: "Lịch hẹn này cần thẻ và sự đồng ý mới. Liên hệ salon để thay người an toàn.",
  error: "Chưa kiểm tra được kết quả. Hãy kiểm tra lại cùng xác nhận này; đừng tạo lịch hẹn khác.",
  retry: "Kiểm tra lại xác nhận này",
  senderTitle: "Nhờ người đi thay",
  senderIntro: "Tạo link riêng cho một người nhận chỗ, giữ nguyên dịch vụ và giờ hẹn.",
  senderRule: "Chỗ của bạn vẫn được giữ cho đến khi người thay xác nhận. Tạo hoặc gửi link chưa hủy lịch và chưa miễn phí hủy.",
  create: "Tạo link nhờ người thay",
  pending: "Đang chờ người thay",
  complete: "Đã xác nhận người thay",
  completeBody: "Người thay đã được xác nhận. Các thành viên khác vẫn giữ nguyên lịch hẹn.",
  revoke: "Dừng nhờ người thay",
  revoked: "Link nhận chỗ đã đóng. Lịch hẹn của bạn vẫn được giữ.",
  recoverLink: "Hiện lại link riêng đã tạo",
  copy: "Sao chép link riêng",
  copied: "Đã sao chép link",
  copyFallback: "Sao chép link trong ô bên dưới. Chỉ gửi cho người sẽ nhận chỗ của bạn.",
  shareHint: "Bạn tự gửi link này. NailIQ chưa gửi email hoặc tin nhắn.",
  refresh: "Cập nhật trạng thái",
  loading: "Đang kiểm tra lựa chọn thay người…",
  senderError: "Chưa kiểm tra được lựa chọn thay người. Thử lại hoặc liên hệ salon. Thao tác này chưa hủy lịch hẹn của bạn.",
  noReplacement: "Lịch hẹn này chưa thể thay người online. Liên hệ salon để được hỗ trợ.",
  linkLabel: "Link riêng để nhận chỗ",
};

export function groupRecoveryMessages(language: GroupRecoveryLanguage) {
  return language === "vi" ? vi : en;
}

export function groupRecoveryError(
  code: string,
  language: GroupRecoveryLanguage,
  context: "form" | "preview" = "form",
): string {
  const t = groupRecoveryMessages(language);
  if (code === "different_guest_required") return t.differentGuest;
  if (code === "invalid_input") return context === "preview" ? t.unavailable : t.invalidPhone;
  if (code === "feature_disabled" || code === "contact_salon") return t.unavailable;
  if (code.includes("expired")) return t.expired;
  if (code.includes("card") || code.includes("payment")) return t.cardRequired;
  if (code.includes("changed") || code.includes("conflict") || code.includes("too_late")) return t.changed;
  if (code.includes("invalid") || code.includes("not_found") || code.includes("revoked")) return t.unavailable;
  return t.error;
}
