import type { UserMessages } from "./en";

/**
 * User-facing copy (owner / dashboard / marketing): Vietnamese.
 */
export const userVi: UserMessages = {
  brandName: "NailIQ",
  heroHeadline: "Đừng để mất khách khi bạn đang bận",
  seoIntro:
    "NailIQ là hệ thống đặt lịch, tự động hóa và tăng trưởng dùng AI cho tiệm nail. Giúp bạn nhận lịch online, giảm cuộc gọi nhỡ và vận hành lễ tân êm hơn—mà không phải thêm cả đống công cụ rời rạc.",
  benefitsHeading: "Bạn nhận được gì với NailIQ",
  benefits: [
    {
      title: "Lịch hẹn gần như tự chạy",
      body: "Khách chọn dịch vụ và giờ phù hợp quy tắc của bạn, lịch đầy hơn trong khi bạn tập trung phục vụ.",
    },
    {
      title: "Lễ tân không 'tắt đèn'",
      body: "Đặt lịch hỗ trợ bởi AI và nhắc lịch giúp giảm vắng mặt và khoảng trống phút chót, kể cả khi điện thoại reo liên tục.",
    },
    {
      title: "Một hệ thống cho tăng trưởng",
      body: "Website, lịch và tự động hóa nằm chung một nơi để marketing, vận hành và trải nghiệm khách đồng nhất.",
    },
  ] as const,
  tagline: "Salon của bạn vẫn nhận lịch — kể cả khi bạn bận rộn",
  setupTime: "Hầu hết salon hoàn tất thiết lập dưới 2 phút.",
  cta: "🚀 Có lịch đầu tiên trong 2 phút",
  ctaMobile: "🚀 Được đặt lịch trong 2 phút",
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
  serviceStrip: ["Chăm sóc chân", "Gel", "Làm móng tay"] as readonly [
    string,
    string,
    string,
  ],
};
