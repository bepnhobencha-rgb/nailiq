import type { UserMessages } from "./en";

export const userVi: UserMessages = {
  brandName: "NailIQ",
  seoIntro:
    "NailIQ là hệ thống đặt lịch và vận hành dùng AI cho tiệm nail.",
  home: {
    headline: "Vận hành tiệm với NailIQ",
    subline:
      "Tạo link đặt lịch công khai, quản lý lịch hôm nay và phát triển trong một nơi.",
    ctaRegister: "Bắt đầu miễn phí",
    footerNote: "Lần đầu? Tạo tiệm chỉ trong vài phút.",
    navOwnerLogin: "Chủ tiệm đăng nhập",
    navOwnerLoginShort: "Đăng nhập",
    alreadySalonPrefix: "Đã có tiệm? ",
    signInLink: "Đăng nhập →",
    landingUrgency:
      "⚠️ Hầu hết tiệm mất $50–$200 mỗi ngày từ cuộc gọi nhỡ",
    landingH1Line1: "Bạn đang mất tiền mỗi ngày.",
    landingH1Gold: "Không phải chỉ mất lịch.",
    landingBody1:
      "Bạn đang bận làm khách. Điện thoại reo. Bạn không bắt máy.",
    landingBody2: "Khách đó đặt tiệm khác.",
    landingBody3: "Bạn không bao giờ biết mình đã mất họ.",
    landingPhonePlaceholder: "Nhập số điện thoại của tiệm...",
    landingCta: "Có lịch đầu tiên trong 2 phút",
    landingMicrotrust: "No app. Không setup. Không cần thẻ.",
    landingZap:
      "⚡ Nếu không fix hôm nay, bạn vẫn sẽ mất khách ngày mai",
    landingEarnedTitle: "+$113 earned today",
    landingEarnedSub: "từ những cuộc gọi bạn không bắt máy",
    landingFeedNewBooking: "Lịch mới",
    landingSectionEyebrow:
      "Bạn không thấy những gì bạn đang mất. Nhưng nó xảy ra mỗi ngày.",
    landingSectionTitle: "Tiệm đang mất tiền từ những khoảnh khắc nhỏ",
    landingProblem1: "LỠ CUỘC GỌI KHI ĐANG LÀM KHÁCH",
    landingProblem2: "GIỜ TRỐNG KHÔNG ĐƯỢC LẤP",
    landingProblem3: "KHÁCH ĐẶT TIỆM KHÁC",
    landingClosingLine1: "Bạn đang mất khách",
    landingClosingLine2: "mỗi ngày.",
    landingClosingSub:
      "Nếu không bắt đầu hôm nay, bạn sẽ tiếp tục mất họ.",
    landingClosingCta: "Bắt đầu lấy lại khách ngay",
    landingSocialProof1: "🔴 LIVE • Anna vừa có lịch 2 phút trước",
    landingSocialProof2: "Lisa đã lấp 3 giờ trống hôm nay",
    landingSocialProof3: "Jenny vừa thêm $113 từ cuộc gọi nhỡ",
    landingSocialProof4: "842 tiệm nhận booking trong 24h qua",
    landingFeedServices: [
      "Pedicure",
      "Gel Manicure",
      "Full Set",
      "Classic Set",
      "Hybrid Volume",
    ],
  },
  register: {
    returningOwnerHint:
      "Đã là chủ tiệm? Nhập số điện thoại để đăng nhập lại.",
    welcomeBackAfterSend:
      "Chào mừng trở lại! Nhập mã để vào bảng điều khiển.",
    welcomeBackVerifySubtext:
      "Chào mừng trở lại! Nhập mã để vào bảng điều khiển.",
    newDemoOtpBadgeNote:
      "DEMO · Mã OTP hiển thị bên dưới.",
  },
  salonDashboard: {
    title: "Bảng điều khiển tiệm",
    slugLabel: "URL",
    bookingPageUrl: "Trang đặt lịch",
    copyLink: "Sao chép link",
    copied: "Đã chép",
    viewBookingPage: "Mở trang đặt lịch",
    todaySummary: "Hôm nay",
    totalToday: "Tổng lịch",
    pending: "Chờ xác nhận",
    confirmed: "Đã xác nhận",
    completed: "Hoàn thành",
    estRevenue: "Doanh thu ước tính",
    todayAppointments: "Lịch hôm nay",
    upcomingConfirmed: "Sắp tới (đã xác nhận)",
    noBookingsToday: "Hôm nay chưa có lịch.",
    noUpcoming: "Không có lịch đã xác nhận trong 7 ngày tới.",
    advanceStatus: "Đổi trạng thái",
    client: "Khách",
    service: "Dịch vụ",
    salonStaffLabel: "Thợ",
    phone: "Điện thoại",
    clientNotes: "Ghi chú khách",
    loading: "Đang tải…",
    refresh: "Làm mới",
    navSettings: "Cài đặt",
    lastUpdatedJustNow: "Cập nhật: vừa xong",
    lastUpdatedOneMinuteAgo: "Cập nhật: 1 phút trước",
    lastUpdatedMinutesAgo: "Cập nhật: {count} phút trước",
    emptyTodayTitle: "Hôm nay chưa có lịch.",
    emptyTodayHint: "Chia sẻ link đặt lịch để khách đặt chỗ.",
    loadError: "Không tải được bảng điều khiển.",
    statusPending: "Chờ",
    statusConfirmed: "Đã xác nhận",
    statusCompleted: "Hoàn thành",
  },
  salonSettings: {
    pageTitle: "Cài đặt",
    pageIntro:
      "Chỉnh dịch vụ, nhân viên, giờ mở cửa và địa chỉ tiệm—tất cả tại một nơi.",
    sectionServices: "Dịch vụ & giá",
    sectionStaff: "Nhân viên",
    sectionHours: "Giờ mở cửa",
    sectionAddress: "Địa chỉ tiệm",
    hintRecoveryEmail:
      "Để thêm hoặc đổi email khôi phục cho tài khoản, dùng thanh nhắc trên bảng điều khiển.",
  },
};
