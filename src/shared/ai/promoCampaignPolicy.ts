export type PromoCampaignLanguage = "en" | "vi";

export type PromoCampaignDraft = {
  title: string;
  reasoning: string;
  draftMessage: string;
  language: PromoCampaignLanguage;
};

const URL_OR_EMAIL =
  /(?:https?:\/\/|www\.|[\w.%+-]+@[\w.-]+\.[a-z]{2,})/iu;
const PHONE = /(?:\+?\d[\d ().-]{7,}\d)/u;
const NUMERIC_OFFER =
  /(?:\d|[%$]|\bCAD\b|\bUSD\b|\bdollars?\b|\bpercent\b|phần\s*trăm)/iu;
const UNSAFE_CLAIM =
  /\b(?:guarantee(?:d)?|risk[- ]?free|best price|cheapest|refund|compensation|liable|liability)\b|\bmiễn\s*phí\b|\bhoàn\s*tiền\b|\bbồi\s*thường\b|\bchịu\s*trách\s*nhiệm\b/iu;

const clean = (value: unknown, max: number): string =>
  String(value ?? "")
    .replace(/[<>\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);

export function promoCampaignLanguage(value: unknown): PromoCampaignLanguage {
  return value === "vi" ? "vi" : "en";
}

export function promoCampaignHasOfferFacts(value: string): boolean {
  return NUMERIC_OFFER.test(value);
}

export function safeAiPromoCampaignMessage(value: unknown): string | null {
  const message = clean(value, 1_000);
  if (message.length < 20) return null;
  if (
    URL_OR_EMAIL.test(message) ||
    PHONE.test(message) ||
    NUMERIC_OFFER.test(message) ||
    UNSAFE_CLAIM.test(message)
  ) {
    return null;
  }
  return message;
}

export function safeOwnerPromoCampaignMessage(
  value: unknown,
  offerFactsConfirmed: boolean,
): string | null {
  const message = clean(value, 1_000);
  if (message.length < 20) return null;
  if (URL_OR_EMAIL.test(message) || PHONE.test(message) || UNSAFE_CLAIM.test(message)) {
    return null;
  }
  if (NUMERIC_OFFER.test(message) && !offerFactsConfirmed) return null;
  return message;
}

export function promoCampaignFallback(
  language: PromoCampaignLanguage,
): PromoCampaignDraft {
  if (language === "vi") {
    return {
      title: "Ý tưởng ưu đãi cần chủ tiệm xác nhận",
      reasoning:
        "Dữ liệu gần đây cho thấy có cơ hội giới thiệu một ưu đãi do chủ tiệm cấu hình cho các khung giờ còn trống.",
      draftMessage:
        "Tiệm vừa chuẩn bị một ưu đãi mới dành cho khách. Hãy xem thông tin đã được tiệm xác nhận trên trang đặt lịch trước khi chọn thời gian phù hợp.",
      language,
    };
  }
  return {
    title: "Promotion idea awaiting owner confirmation",
    reasoning:
      "Recent salon activity suggests an opportunity to feature an owner-configured offer for quieter appointment windows.",
    draftMessage:
      "Our salon has prepared a new offer for guests. Review the salon-confirmed details on the booking page before choosing a time that works for you.",
    language,
  };
}

export function normalizePromoCampaignDraft(
  input: {
    title?: unknown;
    reasoning?: unknown;
    draftMessage?: unknown;
  },
  language: PromoCampaignLanguage,
): PromoCampaignDraft {
  const fallback = promoCampaignFallback(language);
  const title = clean(input.title, 120);
  const reasoning = clean(input.reasoning, 600);
  const draftMessage = safeAiPromoCampaignMessage(input.draftMessage);
  return {
    title: title.length >= 3 && !URL_OR_EMAIL.test(title) ? title : fallback.title,
    reasoning:
      reasoning.length >= 10 && !URL_OR_EMAIL.test(reasoning)
        ? reasoning
        : fallback.reasoning,
    draftMessage: draftMessage ?? fallback.draftMessage,
    language,
  };
}

export function promoCampaignPeriodKey(todayYmd: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(todayYmd)) return null;
  const [year, month, day] = todayYmd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  const dow = date.getUTCDay();
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}
