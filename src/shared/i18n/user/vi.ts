import type { UserMessages } from "./en";

/**
 * User-facing copy (owner / dashboard / marketing): Vietnamese.
 */
export const userVi: UserMessages = {
  brandName: "NailIQ",
  heroHeadline: "Khách vẫn book bạn\ndù lịch đã kín",
  heroSubline: "Vẫn nhận lịch — kể cả khi bạn bận",
  seoIntro:
    "NailIQ là hệ thống đặt lịch, tự động hóa và tăng trưởng dùng AI cho tiệm nail. Giúp bạn nhận lịch online, giảm cuộc gọi nhỡ và vận hành lễ tân êm hơn—mà không phải thêm cả đống công cụ rời rạc.",
  benefitsHeading: "Bạn nhận được gì với NailIQ",
  benefits: [
    {
      title: "Lịch hẹn gần như tự chạy",
      body: "Khách chọn dịch vụ và giờ phù hợp quy tắc của bạn, lịch đầy hơn trong khi bạn tập trung phục vụ.",
      phoneScene: "booking",
    },
    {
      title: "AI Genesis: thực đơn, đã sẵn sàng",
      body: "Quét menu giấy hoặc bảng giá—NailIQ gom thành danh sách dịch vụ gọn, book được trong vài giây.",
      phoneScene: "ai",
    },
    {
      title: "Một hệ thống cho tăng trưởng",
      body: "Website, lịch và tự động hóa nằm chung một nơi để marketing, vận hành và trải nghiệm khách đồng nhất.",
    },
  ] as const,
  tagline: "Salon của bạn vẫn nhận lịch — kể cả khi bạn bận rộn",
  setupTime: "Hầu hết salon hoàn tất thiết lập dưới 2 phút.",
  cta: "Có lịch đầu tiên trong 2 phút",
  ctaSubline: "Không app. Không thiết lập.",
  ctaTrustLine: "Thiết lập dưới 2 phút",
  phonePlaceholder: "Nhập số điện thoại",
  phoneHint: "Chúng tôi gửi link đặt lịch qua tin nhắn ngay",
  socialProof: "Hơn 100 salon đang dùng NailIQ",
  valueCardTitle: "Lối vào tự tin, điềm tĩnh",
  valueCardBadge: "NailIQ",
  footerPoweredBy: "Cung cấp bởi NailIQ",
  valueCardBody:
    "Một lớp kính cho đặt lịch, thực đơn và những chi tiết khiến tiệm bạn thật sự 'xịn'—trước khi khách bước vào.",
  phoneScreenBody:
    "Link của bạn, thương hiệu của bạn, quy tắc của bạn—trải nghiệm gọn trên iPhone mà khách thực sự dùng.",
  serviceStrip: ["Chăm sóc chân", "Làm móng tay", "Gel"] as readonly [
    string,
    string,
    string,
  ],
  urgencyLine: "⚡ Bạn có thể lỡ 3–7 lịch hẹn hôm nay",
  liveProof: [
    "Anna vừa được book • 2 phút trước",
    "Jenny lấp đủ 5 suốt hôm nay",
  ] as const,
  phoneActivity: [
    { label: "Anna vừa book", line: "3:00 PM — Pedicure • 450.000₫" },
    { label: "Jenny vừa book", line: "2:15 PM — Gel • 350.000₫" },
  ] as const,
  phoneTimeSlots: ["3:00 PM", "3:30 PM", "4:00 PM"] as const,
  phoneBookingSceneTitle: "Đặt lịch",
  phoneBookingStepService: "Dịch vụ",
  phoneBookingStepTime: "Giờ",
  phoneBookingStepComplete: "Xong",
  phoneBookingContinue: "Tiếp tục",
  phoneBookingBack: "Quay lại",
  phoneBookingDoneTitle: "Đã giữ chỗ",
  phoneBookingDoneSubtitle: "Chúng tôi sẽ gửi xác nhận kèm giờ bạn chọn.",
  phoneBookingDateLine: "Hôm nay · T7, 25 thg 4",
  phoneBookingBookAnother: "Đặt thêm",
  phoneAiSceneLabel: "Quét thực đơn",
  phoneAiSceneHint: "Hướng vào menu của bạn",
  phoneMenuDemoRows: [
    { category: "Manicure", name: "Manicure cổ điển", price: "450.000₫" },
    { category: "Manicure", name: "Gel dặm móng", price: "550.000₫" },
    { category: "Pedicure", name: "Pedicure spa", price: "600.000₫" },
    { category: "Pedicure", name: "Pedicure nhanh", price: "480.000₫" },
  ] as const,
};
