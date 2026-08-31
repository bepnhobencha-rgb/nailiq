export type SmsLocale = "en" | "vi";

export const SMS_TEMPLATE_KEYS = [
  "booking_confirmation",
  "staff_action",
  "reminder_24h",
  "reminder_3h",
  "waitlist_offer",
  "waitlist_invite",
  "review_request",
  "first_visit_followup",
  "save_card_link",
  "deposit_link",
  "noshow_fee_link",
  "late_decline_replacement",
  "rebook_invite",
  "owner_alert",
] as const;

export type SmsTemplateKey = (typeof SMS_TEMPLATE_KEYS)[number];

export type SmsTemplateDefinition = {
  key: SmsTemplateKey;
  labelEn: string;
  labelVi: string;
  descriptionEn: string;
  descriptionVi: string;
  required: boolean;
  defaultEnabled: boolean;
};

export type SmsTemplateSettings = Partial<Record<SmsTemplateKey, boolean>>;

export const SMS_TEMPLATE_DEFINITIONS: readonly SmsTemplateDefinition[] = [
  { key: "booking_confirmation", labelEn: "Booking confirmation", labelVi: "Xác nhận đặt lịch", descriptionEn: "Receipt after a booking is committed.", descriptionVi: "Biên nhận sau khi booking đã được ghi nhận.", required: true, defaultEnabled: true },
  { key: "staff_action", labelEn: "Booking changes", labelVi: "Thay đổi lịch hẹn", descriptionEn: "Cancellation, reschedule, and booking-state receipts.", descriptionVi: "Biên nhận hủy, đổi giờ và thay đổi trạng thái lịch.", required: true, defaultEnabled: true },
  { key: "reminder_24h", labelEn: "24-hour reminder", labelVi: "Nhắc lịch trước 24 giờ", descriptionEn: "Confirm and reschedule links before the visit.", descriptionVi: "Link xác nhận và đổi lịch trước buổi hẹn.", required: false, defaultEnabled: true },
  { key: "reminder_3h", labelEn: "3-hour reminder", labelVi: "Nhắc lịch trước 3 giờ", descriptionEn: "Short same-day reminder.", descriptionVi: "Tin nhắc ngắn trong ngày.", required: false, defaultEnabled: true },
  { key: "waitlist_offer", labelEn: "Waitlist opening", labelVi: "Mời chỗ trống từ waitlist", descriptionEn: "Time-limited opening with a secure claim link.", descriptionVi: "Chỗ trống có thời hạn và link giữ chỗ bảo mật.", required: false, defaultEnabled: true },
  { key: "waitlist_invite", labelEn: "Waitlist invitation", labelVi: "Mời khách trong danh sách chờ", descriptionEn: "Invites an eligible customer when capacity opens.", descriptionVi: "Mời khách phù hợp khi có chỗ trống.", required: false, defaultEnabled: true },
  { key: "review_request", labelEn: "Review request", labelVi: "Mời đánh giá", descriptionEn: "Optional post-visit feedback request.", descriptionVi: "Lời mời đánh giá tùy chọn sau buổi hẹn.", required: false, defaultEnabled: true },
  { key: "first_visit_followup", labelEn: "First-visit follow-up", labelVi: "Chăm sóc sau lần đầu", descriptionEn: "Optional first-visit relationship message.", descriptionVi: "Tin chăm sóc tùy chọn sau lần đầu.", required: false, defaultEnabled: true },
  { key: "save_card_link", labelEn: "Save-card request", labelVi: "Yêu cầu lưu thẻ", descriptionEn: "Secure card-management link; never states an unapproved fee.", descriptionVi: "Link quản lý thẻ bảo mật; không tự khẳng định mức phí chưa duyệt.", required: true, defaultEnabled: true },
  { key: "deposit_link", labelEn: "Deposit request", labelVi: "Yêu cầu đặt cọc", descriptionEn: "Exact approved amount and secure payment link.", descriptionVi: "Đúng số tiền đã duyệt và link thanh toán bảo mật.", required: true, defaultEnabled: true },
  { key: "noshow_fee_link", labelEn: "No-show fee request", labelVi: "Yêu cầu phí vắng mặt", descriptionEn: "Exact approved fee and secure payment link.", descriptionVi: "Đúng mức phí đã duyệt và link thanh toán bảo mật.", required: true, defaultEnabled: true },
  { key: "late_decline_replacement", labelEn: "Group replacement offer", labelVi: "Mời thay thế thành viên nhóm", descriptionEn: "Offers an open group spot without promising it is reserved.", descriptionVi: "Mời chỗ nhóm còn trống nhưng không hứa đã giữ chỗ.", required: false, defaultEnabled: true },
  { key: "rebook_invite", labelEn: "Rebook invitation", labelVi: "Mời đặt lại lịch", descriptionEn: "Optional retention message.", descriptionVi: "Tin giữ chân khách tùy chọn.", required: false, defaultEnabled: true },
  { key: "owner_alert", labelEn: "Owner AI alert", labelVi: "Cảnh báo AI cho chủ tiệm", descriptionEn: "Operational alert to the salon owner.", descriptionVi: "Cảnh báo vận hành gửi chủ tiệm.", required: false, defaultEnabled: true },
] as const;

const DEFINITION_BY_KEY = new Map(
  SMS_TEMPLATE_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function isSmsTemplateKey(value: string): value is SmsTemplateKey {
  return DEFINITION_BY_KEY.has(value as SmsTemplateKey);
}

export function isRequiredSmsTemplate(key: string | undefined): boolean {
  return Boolean(
    key && isSmsTemplateKey(key) && DEFINITION_BY_KEY.get(key)?.required,
  );
}

export function parseSmsTemplateSettings(value: unknown): SmsTemplateSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const settings: SmsTemplateSettings = {};
  for (const definition of SMS_TEMPLATE_DEFINITIONS) {
    if (!definition.required && typeof input[definition.key] === "boolean") {
      settings[definition.key] = input[definition.key] as boolean;
    }
  }
  return settings;
}

export function isSmsTemplateEnabled(
  key: string | undefined,
  settings: unknown,
): boolean {
  if (!key || !isSmsTemplateKey(key)) return true;
  const definition = DEFINITION_BY_KEY.get(key)!;
  if (definition.required) return true;
  return parseSmsTemplateSettings(settings)[key] !== false;
}

const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà".split(""),
);
const GSM_EXTENDED = new Set("^{}\\[~]|€".split(""));

export function estimateSmsSegments(body: string): {
  encoding: "GSM-7" | "UCS-2";
  units: number;
  segments: number;
} {
  let gsmUnits = 0;
  let gsm = true;
  for (const char of body) {
    if (GSM_BASIC.has(char)) gsmUnits += 1;
    else if (GSM_EXTENDED.has(char)) gsmUnits += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) {
    return {
      encoding: "GSM-7",
      units: gsmUnits,
      segments: Math.max(1, Math.ceil(gsmUnits / (gsmUnits <= 160 ? 160 : 153))),
    };
  }
  const units = [...body].length;
  return {
    encoding: "UCS-2",
    units,
    segments: Math.max(1, Math.ceil(units / (units <= 70 ? 70 : 67))),
  };
}

function clean(value: string | null | undefined, fallback: string): string {
  const normalized = String(value ?? "").replace(/\s+/gu, " ").trim();
  return normalized || fallback;
}

export function buildBookingConfirmationSms(input: {
  lang: SmsLocale;
  salonName: string;
  dateLabel: string;
  serviceName?: string | null;
  staffName?: string | null;
  partySize?: number | null;
  address?: string | null;
  manageUrl?: string | null;
}): string {
  const salon = clean(input.salonName, "NailIQ");
  const date = clean(input.dateLabel, input.lang === "vi" ? "giờ đã chọn" : "the selected time");
  const partySize = Number.isInteger(input.partySize) && Number(input.partySize) > 1
    ? Number(input.partySize)
    : null;
  const service = clean(input.serviceName, input.lang === "vi" ? "lịch hẹn" : "appointment");
  const lines = input.lang === "vi"
    ? [
        partySize
          ? `Đã xác nhận lịch nhóm ${partySize} người tại ${salon}.`
          : `Đã xác nhận ${service} tại ${salon}.`,
        `Thời gian: ${date}.`,
        input.staffName ? `Nhân viên: ${clean(input.staffName, "")}.` : null,
        input.address ? `Địa chỉ: ${clean(input.address, "")}.` : null,
        input.manageUrl ? `Xem hoặc đổi lịch: ${input.manageUrl.trim()}` : null,
      ]
    : [
        partySize
          ? `Group booking confirmed for ${partySize} guests at ${salon}.`
          : `${service} confirmed at ${salon}.`,
        `Time: ${date}.`,
        input.staffName ? `Staff: ${clean(input.staffName, "")}.` : null,
        input.address ? `Address: ${clean(input.address, "")}.` : null,
        input.manageUrl ? `View or change: ${input.manageUrl.trim()}` : null,
      ];
  return lines.filter(Boolean).join("\n");
}

export function buildReminderSms(input: {
  lang: SmsLocale;
  reminderType: "24h" | "3h";
  serviceName: string;
  salonName: string;
  timeLabel: string;
  confirmUrl: string;
  rescheduleUrl: string;
  aiLead?: string | null;
}): string {
  const service = clean(
    input.serviceName,
    input.lang === "vi" ? "lịch hẹn" : "appointment",
  );
  const when = input.lang === "vi"
    ? input.reminderType === "24h" ? "vào ngày mai" : "trong 3 giờ nữa"
    : input.reminderType === "24h" ? "tomorrow" : "in 3 hours";
  const fixedLead = input.lang === "vi"
    ? `Nhắc lịch: ${service} tại ${clean(input.salonName, "NailIQ")} ${when} lúc ${clean(input.timeLabel, "giờ đã chọn")}.`
    : `Reminder: Your ${service} at ${clean(input.salonName, "NailIQ")} is ${when} at ${clean(input.timeLabel, "the selected time")}.`;
  const lead = input.aiLead?.trim() || fixedLead;
  return input.lang === "vi"
    ? `${lead}\nXác nhận: ${input.confirmUrl}\nĐổi lịch: ${input.rescheduleUrl}\nNhắn STOP để ngừng nhận tin.`
    : `${lead}\nConfirm: ${input.confirmUrl}\nReschedule: ${input.rescheduleUrl}\nReply STOP to opt out.`;
}

export function buildBookingChangeSms(input: {
  event: "create" | "reschedule" | "cancel" | "no_show" | "staff_change";
  lang: SmsLocale;
  salonName: string;
  serviceName: string;
  whenLabel: string;
  customerName?: string | null;
  staffName?: string | null;
  salonPhone?: string | null;
}): string | null {
  if (input.event === "no_show") return null;
  const salon = clean(input.salonName, "NailIQ");
  const service = clean(input.serviceName, input.lang === "vi" ? "lịch hẹn" : "appointment");
  const when = clean(input.whenLabel, input.lang === "vi" ? "giờ đã chọn" : "the selected time");
  const greeting = input.customerName?.trim()
    ? input.lang === "vi" ? `Chào ${clean(input.customerName, "")}, ` : `Hi ${clean(input.customerName, "")}, `
    : "";
  const call = input.salonPhone?.trim()
    ? input.lang === "vi" ? ` Cần đổi? Gọi ${input.salonPhone.trim()}.` : ` Questions? Call ${input.salonPhone.trim()}.`
    : "";
  if (input.lang === "vi") {
    if (input.event === "create") return `${greeting}lịch hẹn ${service} của bạn tại ${salon} đã được đặt: ${when}.${call}`;
    if (input.event === "reschedule") return `${greeting}lịch hẹn ${service} của bạn tại ${salon} đã được dời sang: ${when}.${call}`;
    if (input.event === "cancel") return `${greeting}lịch hẹn ${service} của bạn tại ${salon} (${when}) đã được huỷ.${call}`;
    return `${greeting}lịch hẹn ${service} của bạn tại ${salon} vẫn giữ nguyên vào ${when} và sẽ do ${clean(input.staffName, "một nhân viên khác")} phục vụ.${call}`;
  }
  if (input.event === "create") return `${greeting}your ${service} appointment at ${salon} is booked for ${when}.${call}`;
  if (input.event === "reschedule") return `${greeting}your ${service} appointment at ${salon} has been moved to ${when}.${call}`;
  if (input.event === "cancel") return `${greeting}your ${service} appointment at ${salon} (${when}) has been cancelled.${call}`;
  return `${greeting}your ${service} appointment at ${salon} remains scheduled for ${when} and will be with ${clean(input.staffName, "another team member")}.${call}`;
}

export function buildWaitlistSms(input: {
  lang: SmsLocale;
  salonName: string;
  serviceName: string;
  detail?: string | null;
  claimUrl: string;
  holdMinutes?: number;
}): string {
  const hold = Math.max(1, Math.round(input.holdMinutes ?? 20));
  const detail = input.detail?.trim() ? ` (${input.detail.trim()})` : "";
  return input.lang === "vi"
    ? `${clean(input.salonName, "NailIQ")}: Có chỗ trống cho ${clean(input.serviceName, "dịch vụ")}${detail}. Chưa được đặt cho đến khi bạn xác nhận. Giữ chỗ trong ${hold} phút: ${input.claimUrl}`
    : `${clean(input.salonName, "NailIQ")}: An opening is available for ${clean(input.serviceName, "your service")}${detail}. It is not booked until you confirm. Claim within ${hold} minutes: ${input.claimUrl}`;
}

export function buildGroupMemberInviteSms(input: {
  lang: SmsLocale;
  organizerName?: string | null;
  salonName: string;
  dateLabel: string;
  serviceName?: string | null;
  staffName?: string | null;
  rsvpUrl: string;
}): string {
  const organizer = clean(
    input.organizerName,
    input.lang === "vi" ? "Người tổ chức" : "Your organizer",
  );
  const lines = input.lang === "vi"
    ? [
        `${organizer} đã mời bạn vào lịch nhóm tại ${clean(input.salonName, "NailIQ")}.`,
        `Thời gian: ${clean(input.dateLabel, "giờ đã chọn")}.`,
        input.serviceName ? `Dịch vụ: ${clean(input.serviceName, "")}.` : null,
        input.staffName ? `Nhân viên: ${clean(input.staffName, "")}.` : null,
        `Xác nhận tham dự hoặc từ chối: ${input.rsvpUrl}`,
      ]
    : [
        `${organizer} invited you to a group booking at ${clean(input.salonName, "NailIQ")}.`,
        `Time: ${clean(input.dateLabel, "the selected time")}.`,
        input.serviceName ? `Service: ${clean(input.serviceName, "")}.` : null,
        input.staffName ? `Staff: ${clean(input.staffName, "")}.` : null,
        `Accept or decline: ${input.rsvpUrl}`,
      ];
  return lines.filter(Boolean).join("\n");
}

export function buildGroupReplacementSms(input: {
  lang: SmsLocale;
  recipientName?: string | null;
  salonName: string;
  dateLabel: string;
  serviceName: string;
  bookingUrl: string;
}): string {
  const greeting = input.recipientName?.trim()
    ? `${clean(input.recipientName, "")}, `
    : "";
  return input.lang === "vi"
    ? `${greeting}${clean(input.salonName, "NailIQ")} có một chỗ nhóm vừa mở cho ${clean(input.serviceName, "dịch vụ")} vào ${clean(input.dateLabel, "giờ đã chọn")}. Chỗ chưa được giữ cho đến khi xác nhận: ${input.bookingUrl}`
    : `${greeting}${clean(input.salonName, "NailIQ")} has an open group spot for ${clean(input.serviceName, "your service")} at ${clean(input.dateLabel, "the selected time")}. It is not held until confirmed: ${input.bookingUrl}`;
}

export function buildSaveCardSms(input: {
  lang: SmsLocale;
  salonName: string;
  url: string;
}): string {
  return input.lang === "vi"
    ? `${clean(input.salonName, "NailIQ")}: Lưu thẻ bảo mật để giữ lịch. Không thu tiền lúc này; mọi khoản phí chỉ theo chính sách bạn đã đồng ý: ${input.url}`
    : `${clean(input.salonName, "NailIQ")}: Securely save a card to hold your appointment. No charge now; any fee follows the policy you accepted: ${input.url}`;
}

export function buildPaymentRequestSms(input: {
  kind: "deposit" | "noshow_fee";
  lang: SmsLocale;
  salonName: string;
  amount: string;
  url: string;
}): string {
  if (input.lang === "vi") {
    const label = input.kind === "deposit" ? "tiền cọc" : "phí vắng mặt đã được duyệt";
    return `${clean(input.salonName, "NailIQ")}: Vui lòng thanh toán ${label} ${input.amount}: ${input.url}`;
  }
  const label = input.kind === "deposit" ? "deposit" : "approved no-show fee";
  return `${clean(input.salonName, "NailIQ")}: Please pay the ${label} of ${input.amount}: ${input.url}`;
}

export function buildReviewRequestSms(input: {
  lang: SmsLocale;
  salonName: string;
  reviewUrl: string;
}): string {
  return input.lang === "vi"
    ? `Cảm ơn bạn đã ghé ${clean(input.salonName, "NailIQ")}. Chia sẻ trải nghiệm trong 30 giây: ${input.reviewUrl}`
    : `Thanks for visiting ${clean(input.salonName, "NailIQ")}. Share your experience in 30 seconds: ${input.reviewUrl}`;
}

export function buildSmsTemplatePreview(key: SmsTemplateKey, lang: SmsLocale): string {
  const salonName = "Hi-Lite Head Spa";
  const url = "nailiq.ca/a/Ab3x9";
  switch (key) {
    case "booking_confirmation":
      return buildBookingConfirmationSms({ lang, salonName, dateLabel: "Tue, Sep 1, 9:00 AM", serviceName: "Hi-Lite Classic", manageUrl: url });
    case "reminder_24h":
      return lang === "vi" ? `Nhắc lịch: Hi-Lite Classic tại ${salonName} vào ngày mai lúc 9:00 AM.\nXác nhận hoặc đổi lịch: ${url}` : `Reminder: Hi-Lite Classic at ${salonName} is tomorrow at 9:00 AM.\nConfirm or reschedule: ${url}`;
    case "reminder_3h":
      return lang === "vi" ? `Nhắc lịch: Hi-Lite Classic tại ${salonName} trong 3 giờ nữa. Xem lịch: ${url}` : `Reminder: Hi-Lite Classic at ${salonName} starts in 3 hours. View: ${url}`;
    case "waitlist_offer":
    case "waitlist_invite":
      return buildWaitlistSms({ lang, salonName, serviceName: "Hi-Lite Classic", detail: "Tue, 9:00 AM", claimUrl: url });
    case "review_request":
      return buildReviewRequestSms({ lang, salonName, reviewUrl: url });
    case "save_card_link":
      return buildSaveCardSms({ lang, salonName, url });
    case "deposit_link":
      return buildPaymentRequestSms({ kind: "deposit", lang, salonName, amount: "$20.00", url });
    case "noshow_fee_link":
      return buildPaymentRequestSms({ kind: "noshow_fee", lang, salonName, amount: "$20.00", url });
    case "late_decline_replacement":
      return lang === "vi" ? `${salonName}: Một chỗ trong nhóm vừa mở. Chưa được giữ cho đến khi xác nhận: ${url}` : `${salonName}: A group spot just opened. It is not held until confirmed: ${url}`;
    case "staff_action":
      return lang === "vi" ? `${salonName}: Lịch Hi-Lite Classic đã được đổi sang 10:00 AM. Xem chi tiết: ${url}` : `${salonName}: Hi-Lite Classic was rescheduled to 10:00 AM. Details: ${url}`;
    case "first_visit_followup":
      return lang === "vi" ? `Cảm ơn bạn đã đến ${salonName} lần đầu. Khi sẵn sàng, đặt lần tiếp theo tại ${url}` : `Thanks for your first visit to ${salonName}. When ready, book your next visit at ${url}`;
    case "rebook_invite":
      return lang === "vi" ? `${salonName}: Đã đến lúc chăm sóc tiếp theo. Chọn giờ phù hợp: ${url}` : `${salonName}: It may be time for your next visit. Choose a time: ${url}`;
    case "owner_alert":
      return lang === "vi" ? `${salonName}: AI phát hiện 3 lịch có nguy cơ trống ngày mai. Xem và duyệt hành động trong Dashboard.` : `${salonName}: AI found 3 at-risk openings tomorrow. Review and approve actions in Dashboard.`;
  }
}
