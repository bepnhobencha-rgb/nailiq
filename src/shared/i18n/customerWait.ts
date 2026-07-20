import type { UserLanguage } from "@/shared/i18n/user/types";

/**
 * Localized copy for the customer-facing wait page.
 *
 * Kept distinct from `userMessages` because the page is a public,
 * single-purpose surface — no need to drag in the entire owner +
 * landing tree.
 */
export type CustomerWaitMessages = {
  greeting: string;
  yourPosition: string;
  /** Pill shown when the customer has been assigned (no queue position). */
  assigned: string;
  estimatedWait: string;
  /** "Ready around {time}" — interpolate {time}. */
  readyAround: string;
  /** "{n} min" — short label under the ETA. */
  minutesShort: (n: number) => string;
  readyNow: string;
  serviceLabel: string;
  statusLabel: string;
  statusWaiting: string;
  itsYourTurn: string;
  pleaseComeIn: string;
  /** "with {name}" — staff name suffix on the ready screen. */
  withStaff: string;
  /** "Thank you for visiting {salon}!" */
  thankYou: string;
  seeYouAgain: string;
  cancelled: string;
  /** Self-service actions on the wait page (SMS deep-links here). */
  rescheduleCta: string;
  cancelCta: string;
  autoRefreshNote: string;
  /** Fallback screen — booking row missing or expired. */
  notFound: string;
  /** Fallback screen — service-role lookup blew up. */
  tryAgainLater: string;
  /** Hint under the fallback message. */
  contactSalon: string;
};

const en: CustomerWaitMessages = {
  greeting: "Hi {name} 👋",
  yourPosition: "Your position",
  assigned: "Assigned",
  estimatedWait: "Estimated wait",
  readyAround: "Ready around {time}",
  minutesShort: (n: number) => `~${n} min`,
  readyNow: "Ready now",
  serviceLabel: "Service",
  statusLabel: "Status",
  statusWaiting: "Waiting",
  itsYourTurn: "It's your turn!",
  pleaseComeIn: "Please come in 🎉",
  withStaff: "with {name}",
  thankYou: "Thank you for visiting {salon}!",
  seeYouAgain: "See you again 💛",
  cancelled: "This booking was cancelled",
  rescheduleCta: "Reschedule",
  cancelCta: "Cancel appointment",
  autoRefreshNote: "This page updates automatically — no need to refresh",
  notFound: "We couldn't find this booking",
  tryAgainLater: "Couldn't load — please try again in a moment",
  contactSalon: "If you just joined the queue, ask the front desk for a fresh link.",
};

const vi: CustomerWaitMessages = {
  greeting: "Xin chào {name} 👋",
  yourPosition: "Vị trí của bạn",
  assigned: "Đã sắp xếp",
  estimatedWait: "Thời gian chờ",
  readyAround: "Sẵn sàng lúc {time}",
  minutesShort: (n: number) => `~${n} phút`,
  readyNow: "Sẵn sàng",
  serviceLabel: "Dịch vụ",
  statusLabel: "Trạng thái",
  statusWaiting: "Đang chờ",
  itsYourTurn: "Đến lượt bạn rồi!",
  pleaseComeIn: "Mời bạn vào tiệm 🎉",
  withStaff: "Cùng {name}",
  thankYou: "Cảm ơn bạn đã ghé {salon}!",
  seeYouAgain: "Hẹn gặp lại 💛",
  cancelled: "Lịch hẹn đã được huỷ",
  rescheduleCta: "Đổi giờ hẹn",
  cancelCta: "Huỷ lịch hẹn",
  autoRefreshNote: "Trang này tự cập nhật — không cần F5",
  notFound: "Không tìm thấy lịch hẹn này",
  tryAgainLater: "Không tải được — vui lòng thử lại sau ít phút",
  contactSalon: "Nếu bạn vừa vào hàng chờ, hỏi tiếp tân để lấy link mới.",
};

export function getCustomerWaitMessages(
  lang: UserLanguage,
): CustomerWaitMessages {
  return lang === "vi" ? vi : en;
}
