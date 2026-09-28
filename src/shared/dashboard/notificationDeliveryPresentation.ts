export type NotificationDeliveryPresentation = {
  label: string;
  detail: string;
  tone: "success" | "error" | "warning";
};

/** Provider acceptance is not proof that a customer received or read a message. */
export function notificationDeliveryPresentation(
  status: string,
): NotificationDeliveryPresentation {
  switch (status) {
    case "delivered":
      return {
        label: "✓ Đã giao",
        detail: "Nhà cung cấp báo đã giao; không xác nhận khách đã đọc.",
        tone: "success",
      };
    case "failed":
      return {
        label: "✗ Gửi thất bại",
        detail: "Gửi tin thất bại; chưa có bằng chứng giao cho khách.",
        tone: "error",
      };
    case "undelivered":
      return {
        label: "✗ Không giao được",
        detail: "Nhà cung cấp báo không giao được tin này.",
        tone: "error",
      };
    case "suppressed":
      return {
        label: "— Không gửi",
        detail: "Tin này được chặn trước khi gọi nhà cung cấp.",
        tone: "warning",
      };
    case "sent":
    case "accepted":
    case "queued":
      return {
        label: "⏳ Chờ xác nhận giao",
        detail: "Nhà cung cấp đã nhận yêu cầu; chưa có xác nhận giao cho khách.",
        tone: "warning",
      };
    case "sending":
      return {
        label: "⏳ Đang gửi",
        detail: "Chưa có kết quả nhận hoặc giao tin từ nhà cung cấp.",
        tone: "warning",
      };
    default:
      return {
        label: "? Chưa xác minh",
        detail: "Chưa có kết quả gửi tin đáng tin cậy; không coi là đã giao.",
        tone: "warning",
      };
  }
}
