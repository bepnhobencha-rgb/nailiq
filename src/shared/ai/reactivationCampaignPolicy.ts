export type ReactivationCampaignKind = "winback" | "rebook";

export type ReactivationCampaignDraft = {
  title: string;
  messageEn: string;
  messageVi: string;
};

const URL_OR_EMAIL =
  /(?:https?:\/\/|www\.|[\w.%+-]+@[\w.-]+\.[a-z]{2,})/iu;
const PHONE = /(?:\+?\d[\d ().-]{7,}\d)/u;
const UNSAFE_OFFER =
  /(?:[%$]|\b(?:discount|percent|refund|guarantee|free)\b|\bgiảm\s*giá\b|\bphần\s*trăm\b|\bhoàn\s*tiền\b|\bmiễn\s*phí\b)/iu;
const CONTROL_INSTRUCTION =
  /(?:ignore (?:all |the )?(?:previous|above)|system prompt|developer message|do not follow)/iu;

const clean = (value: unknown, max: number): string =>
  String(value ?? "")
    .replace(/[<>\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);

export function safeReactivationCampaignMessage(value: unknown): string | null {
  const message = clean(value, 480);
  if (message.length < 20) return null;
  if (
    URL_OR_EMAIL.test(message) ||
    PHONE.test(message) ||
    UNSAFE_OFFER.test(message) ||
    CONTROL_INSTRUCTION.test(message)
  ) {
    return null;
  }
  return message;
}

export function deterministicReactivationCampaignDraft(input: {
  kind: ReactivationCampaignKind;
  salonName: string;
}): ReactivationCampaignDraft {
  const salon = clean(input.salonName, 100) || "our salon";
  if (input.kind === "winback") {
    return {
      title: "Win-back campaign draft",
      messageEn: `We would love to welcome you back to ${salon}. When you are ready, visit our booking page to choose a service and time that works for you.`,
      messageVi: `${salon} rất mong được đón bạn quay lại. Khi thuận tiện, bạn có thể vào trang đặt lịch của tiệm để chọn dịch vụ và thời gian phù hợp.`,
    };
  }
  return {
    title: "Rebook campaign draft",
    messageEn: `It may be time for your next visit to ${salon}. When you are ready, visit our booking page to choose a service and time that works for you.`,
    messageVi: `Có thể đã đến lúc cho lần ghé tiếp theo tại ${salon}. Khi thuận tiện, bạn có thể vào trang đặt lịch của tiệm để chọn dịch vụ và thời gian phù hợp.`,
  };
}

export function reactivationCampaignPeriodKey(todayYmd: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(todayYmd)) return null;
  const [year, month, day] = todayYmd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  const dayOfWeek = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  return date.toISOString().slice(0, 10);
}
