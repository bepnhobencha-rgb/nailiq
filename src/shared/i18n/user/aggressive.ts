import type { UserLanguage } from "./types";

/**
 * Aligns with `PhoneBookingCopy` in `phoneFrameTypes` (kept here to avoid i18n → UI imports).
 */
export type AggressivePhoneBookingCopy = {
  appBarTitle: string;
  stepService: string;
  stepTime: string;
  stepComplete: string;
  continue: string;
  back: string;
  doneTitle: string;
  doneSubtitle: string;
  dateLine: string;
  bookAnother: string;
};

/**
 * High-urgency conversion landing at `/aggressive` — separate from the Apple-style home.
 * Copy is plain marketing sample (not tenant data).
 */
export type AggressiveMessages = {
  brandName: string;
  /** Plain paragraph for SEO / crawlers */
  seoIntro: string;
  hero: {
    headline: string;
    subline: string;
    cta: string;
    urgency: string;
  };
  moneyLabel: string;
  problem: {
    title: string;
    items: readonly [string, string, string];
  };
  solution: {
    title: string;
    items: readonly [string, string, string];
  };
  benefits: {
    line1: string;
    line2: string;
    line3: string;
  };
  /** Rotating one-liners (long-form `/aggressive` page uses 4; landing may use fewer). */
  socialProof: readonly string[];
  /**
   * Extra copy for the two-column `/aggressive` marketing page (`src/app/aggressive/page.tsx`).
   */
  aggressivePageV2: {
    heroCtaFix: string;
    moneyCounterSubline: string;
    solutionMidCta: string;
    demoKicker: string;
    demoHeadline: string;
    demoFeats: readonly [
      { title: string; desc: string },
      { title: string; desc: string },
      { title: string; desc: string },
    ];
    demoCta: string;
    demoCtaHint: string;
    heroTrustMicroLine: string;
    finalCompetitorLine: string;
    repeatedNoCard: string;
    phoneNewBadge: string;
  };
  noBarrier: {
    line1: string;
    line2: string;
    line3: string;
  };
  final: {
    headline: string;
    cta: string;
  };
  /** Heading above the PhoneFrame */
  sectionLiveDemo: string;
  phone: {
    screenBody: string;
    /** Phone demo app bar: “Today · Book a service” (marketing, not tenant data) */
    phoneAppBar: string;
    serviceStrip: readonly [string, string, string];
    phoneServiceDurations: readonly [string, string, string];
    phoneServicePrices: readonly [string, string, string];
    phoneTimeSlots: readonly [string, string, string, string];
    phoneActivity: readonly { label: string; line: string }[];
    phoneHeroMicroLine: string;
    phoneBookingCounter: string;
    phoneViewSchedule: string;
  };
  phoneBooking: AggressivePhoneBookingCopy;
  phoneAiLabel: string;
  phoneAiHint: string;
  phoneMenuDemoRows: readonly { category: string; name: string; price: string }[];
};

const aggressiveEn: AggressiveMessages = {
  brandName: "NailIQ",
  seoIntro:
    "Missed calls cost nail salons real bookings every day. NailIQ gives clients a 24/7 booking link so your calendar fills while you work—get started in about two minutes.",
  hero: {
    headline: "You’re losing bookings right now",
    subline:
      "Every missed call = a lost client.\nNailIQ makes sure that never happens again.",
    cta: "Get your booking link in 2 minutes",
    urgency: "⚡ You may lose 3–7 clients today",
  },
  moneyLabel: "Lost today from missed calls",
  problem: {
    title: "You’re losing clients every day because:",
    items: [
      "You miss calls while working",
      "Clients can’t book online",
      "They go to another salon",
    ] as const,
  },
  solution: {
    title: "NailIQ fixes this instantly:",
    items: [
      "Clients book you 24/7",
      "No missed calls",
      "Your schedule fills automatically",
    ] as const,
  },
  benefits: {
    line1: "More bookings",
    line2: "Less stress",
    line3: "More money",
  },
  socialProof: [
    "Lisa filled 5 empty slots today",
    "Anna got booked 2 minutes ago",
    "Maria's schedule is full this week",
    "Sophie got 3 bookings overnight",
  ] as const,
  aggressivePageV2: {
    heroCtaFix: "Fix this now",
    moneyCounterSubline:
      "Average for a 1-chair salon.\nYours could be higher.",
    solutionMidCta: "Get your booking link",
    demoKicker: "See it in action",
    demoHeadline: "Bookings come in while you work.",
    demoFeats: [
      {
        title: "Clients book themselves",
        desc: "They pick a service, choose a time, confirm — no calls needed.",
      },
      {
        title: "You get notified instantly",
        desc: "New booking appears in your dashboard the second it's confirmed.",
      },
      {
        title: "Works while you work",
        desc: "Accept bookings at 2 AM, on a Sunday, or mid-manicure.",
      },
    ] as const,
    demoCta: "Start getting bookings",
    demoCtaHint: "2 minutes. No credit card.",
    heroTrustMicroLine: "No credit card. No app to install.",
    finalCompetitorLine:
      "Every minute you wait, another booking goes to a competitor.",
    repeatedNoCard: "2 minutes. No credit card.",
    phoneNewBadge: "+1 new",
  },
  noBarrier: {
    line1: "No app",
    line2: "No setup",
    line3: "Works in 2 minutes",
  },
  final: {
    headline: "Stop losing clients today",
    cta: "Get your booking link now",
  },
  sectionLiveDemo: "Live in your link",
  phone: {
    screenBody:
      "Your link, live—clients book while you do nails. No more voicemail roulette.",
    phoneAppBar: "Today · Book a service",
    serviceStrip: ["Pedicure", "Gel", "Manicure"] as const,
    phoneServiceDurations: ["45 min", "50 min", "40 min"] as const,
    phoneServicePrices: ["$45", "$55", "$40"] as const,
    phoneTimeSlots: ["3:00 PM", "3:30 PM", "4:00 PM", "4:30 PM"] as const,
    phoneActivity: [
      { label: "Anna booked", line: "3:00 PM — Pedicure • $45" },
    ] as const,
    phoneHeroMicroLine: "+1 new booking",
    phoneBookingCounter: "+1 booking",
    phoneViewSchedule: "View schedule →",
  },
  phoneBooking: {
    appBarTitle: "Book",
    stepService: "Service",
    stepTime: "Time",
    stepComplete: "Done",
    continue: "Continue",
    back: "Back",
    doneTitle: "You’re booked",
    doneSubtitle: "We’ll send a confirmation with the time you picked.",
    dateLine: "Today · Sat, Apr 25",
    bookAnother: "Book again",
  },
  phoneAiLabel: "Menu scan",
  phoneAiHint: "Point at your menu",
  phoneMenuDemoRows: [
    { category: "Manicure", name: "Classic Manicure", price: "$45" },
    { category: "Manicure", name: "Gel Rebalance", price: "$55" },
  ],
};

const aggressiveVi: AggressiveMessages = {
  brandName: "NailIQ",
  seoIntro:
    "Cuộc gọi nhỡ khiến tiệm nail mất khách mỗi ngày. NailIQ cấp link đặt lịch 24/7 để lịch đầy khi bạn đang làm—bắt đầu khoảng 2 phút.",
  hero: {
    headline: "Bạn đang mất lịch ngay bây giờ",
    subline:
      "Mỗi cuộc gọi nhỡ = mất khách.\nNailIQ giúp điều đó không lặp lại.",
    cta: "Lấy link đặt lịch trong 2 phút",
    urgency: "⚡ Bạn có thể mất 3–7 khách hôm nay",
  },
  moneyLabel: "Mất hôm nay vì gọi nhỡ",
  problem: {
    title: "Bạn mất khách mỗi ngày vì:",
    items: [
      "Bạn bỏ lỡ cuộc gọi khi đang làm",
      "Khách không đặt lịch online được",
      "Họ chuyển sang salon khác",
    ] as const,
  },
  solution: {
    title: "NailIQ xử lý ngay:",
    items: [
      "Khách book bạn 24/7",
      "Giảm gọi nhỡ",
      "Lịch tự đầy hơn",
    ] as const,
  },
  benefits: {
    line1: "Nhiều lịch hơn",
    line2: "Ít căng hơn",
    line3: "Nhiều tiền hơn",
  },
  socialProof: [
    "Lisa lấp 5 slot trống hôm nay",
    "Anna vừa được book 2 phút trước",
    "Maria kín lịch tuần này",
    "Sophie nhận 3 lịch qua đêm",
  ] as const,
  aggressivePageV2: {
    heroCtaFix: "Sửa ngay",
    moneyCounterSubline:
      "Mức trung bình cho tiệm 1 ghế.\nTiệm bạn có thể cao hơn.",
    solutionMidCta: "Lấy link đặt lịch",
    demoKicker: "Xem thử trên điện thoại",
    demoHeadline: "Lịch vào đều khi bạn đang làm.",
    demoFeats: [
      {
        title: "Khách tự book",
        desc: "Chọn dịch vụ, giờ, xác nhận — không cần gọi.",
      },
      {
        title: "Bạn nhận báo ngay",
        desc: "Lịch mới hiện trên dashboard ngay khi khách xác nhận.",
      },
      {
        title: "Chạy khi bạn đang làm",
        desc: "Nhận lịch lúc 2 giờ sáng, Chủ nhật, hay giữa chừng làm móng.",
      },
    ] as const,
    demoCta: "Bắt đầu nhận lịch",
    demoCtaHint: "2 phút. Không cần thẻ.",
    heroTrustMicroLine: "Không cần thẻ. Không cần cài app.",
    finalCompetitorLine:
      "Càng trì hoãn, càng nhiều lịch rơi vào tay đối thủ.",
    repeatedNoCard: "2 phút. Không cần thẻ.",
    phoneNewBadge: "+1 mới",
  },
  noBarrier: {
    line1: "Không cần app",
    line2: "Không cài đặt rườm rà",
    line3: "Chỉ 2 phút",
  },
  final: {
    headline: "Ngừng mất khách từ hôm nay",
    cta: "Lấy link đặt lịch ngay",
  },
  sectionLiveDemo: "Chạy live trên link của bạn",
  phone: {
    screenBody:
      "Link của bạn, live—khách book khi bạn đang làm. Không còn bỏ lỡ cuộc gọi.",
    phoneAppBar: "Hôm nay · Đặt dịch vụ",
    serviceStrip: ["Chăm sóc bàn chân", "Gel", "Làm móng tay"] as const,
    phoneServiceDurations: ["45 phút", "50 phút", "40 phút"] as const,
    phoneServicePrices: ["450.000₫", "550.000₫", "400.000₫"] as const,
    phoneTimeSlots: ["3:00 PM", "3:30 PM", "4:00 PM", "4:30 PM"] as const,
    phoneActivity: [
      { label: "Anna vừa book", line: "3:00 PM — Pedicure • 450.000₫" },
    ] as const,
    phoneHeroMicroLine: "+1 lịch mới",
    phoneBookingCounter: "+1 lịch",
    phoneViewSchedule: "Xem lịch →",
  },
  phoneBooking: {
    appBarTitle: "Đặt lịch",
    stepService: "Dịch vụ",
    stepTime: "Giờ",
    stepComplete: "Xong",
    continue: "Tiếp tục",
    back: "Quay lại",
    doneTitle: "Đã đặt lịch",
    doneSubtitle: "Chúng tôi gửi xác nhận với giờ bạn chọn.",
    dateLine: "Hôm nay · T7, 25 thg 4",
    bookAnother: "Đặt thêm",
  },
  phoneAiLabel: "Quét menu",
  phoneAiHint: "Chỉ vào menu của bạn",
  phoneMenuDemoRows: [
    { category: "Làm móng tay", name: "Làm móng cơ bản", price: "$45" },
    { category: "Làm móng tay", name: "Gel dặm", price: "$55" },
  ],
};

const byLang: Record<UserLanguage, AggressiveMessages> = {
  en: aggressiveEn,
  vi: aggressiveVi,
};

export function getAggressiveMessages(
  language: UserLanguage,
): AggressiveMessages {
  return byLang[language] ?? aggressiveEn;
}

export { aggressiveEn, aggressiveVi };
