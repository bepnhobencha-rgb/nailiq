/** UI labels describe reservation and protection independently. Only the
 * server's durable receipt projection may supply `saved`. */
export const CARD_PROTECTION_STATES = ["not_required", "awaiting_card", "saving", "saved",
  "reconciliation_pending", "retry_required", "manual_review"] as const;
export type CardProtectionStatus = typeof CARD_PROTECTION_STATES[number];
export function isCardProtectionStatus(value: unknown): value is CardProtectionStatus {
  return typeof value === "string" && (CARD_PROTECTION_STATES as readonly string[]).includes(value);
}
export const CARD_PROTECTION_COPY = {
  en: {
    title: "Card management", policyLanguage: "en", policyLabel: "Cancellation and no-show policy",
    consentLabel: "I agree to this policy and authorize this salon to keep my card on file.",
    legacyPending: "Your appointment and existing card are kept. Please confirm the policy so we can verify the card and activate protection.",
    verifyExisting: "Confirm policy and verify existing card",
    verificationFailed: "We could not verify the card yet. Your appointment is kept. Please try again or ask the salon for help.",
    refreshConsent: "Confirm policy and activate protection",
    reserved: "Appointment reserved", active: "Card protection active",
    pending: "Your appointment is reserved, but your card has not been saved. Please try again to activate late cancellation/no-show protection.",
    retry: "Try saving your card again", checking: "Checking card status…",
    reconciling: "We are checking the previous attempt. Please wait before entering another card.",
    review: "The salon needs to review the previous attempt. You can check again here; your appointment is still reserved.",
    link: "Secure card management link", notRequired: "No card required for this appointment.",
    unavailable: "Card status is temporarily unavailable. Please try again.",
    expired: "This card management link has expired. Please ask the salon for a new link.",
    noCharge: "No payment is taken when saving a card.",
  },
  vi: {
    title: "Quản lý thẻ", policyLanguage: "vi", policyLabel: "Chính sách hủy trễ và no-show",
    consentLabel: "Tôi đồng ý chính sách này và cho phép salon lưu thẻ của tôi.",
    legacyPending: "Lịch hẹn và thẻ cũ vẫn được giữ. Vui lòng xác nhận chính sách để chúng tôi xác minh thẻ và kích hoạt bảo vệ.",
    verifyExisting: "Xác nhận chính sách và xác minh thẻ cũ",
    verificationFailed: "Chưa xác minh được thẻ. Lịch hẹn vẫn được giữ. Vui lòng thử lại hoặc nhờ salon hỗ trợ.",
    refreshConsent: "Xác nhận chính sách và kích hoạt bảo vệ",
    reserved: "Lịch hẹn đã được giữ", active: "Bảo vệ hủy trễ/no-show đã kích hoạt",
    pending: "Lịch hẹn đã được giữ, nhưng thẻ chưa được lưu. Vui lòng thử lại để kích hoạt bảo vệ hủy trễ/no-show.",
    retry: "Thử lưu thẻ lại", checking: "Đang kiểm tra trạng thái thẻ…",
    reconciling: "Chúng tôi đang kiểm tra lần lưu trước. Vui lòng chờ trước khi nhập thẻ khác.",
    review: "Salon cần kiểm tra lần lưu trước. Bạn có thể kiểm tra lại tại đây; lịch hẹn vẫn được giữ.",
    link: "Liên kết quản lý thẻ an toàn", notRequired: "Lịch hẹn này không yêu cầu thẻ.",
    unavailable: "Chưa tải được trạng thái thẻ. Vui lòng thử lại.",
    expired: "Liên kết quản lý thẻ đã hết hạn. Vui lòng nhờ salon tạo liên kết mới.",
    noCharge: "Không thu tiền khi lưu thẻ.",
  },
} as const;
