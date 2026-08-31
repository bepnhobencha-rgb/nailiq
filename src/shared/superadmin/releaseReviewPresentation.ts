import type { UserLanguage } from "@/shared/i18n/user/types";

const CONVENTIONAL_PREFIX =
  /^(?:feat|fix|chore|docs|refactor|perf|test|build|ci|revert)(?:\([^)]*\))?!?:\s*/i;
const CONVENTIONAL_MARKER =
  /(?=(?:feat|fix|chore|docs|refactor|perf|test|build|ci|revert)(?:\([^)]*\))?!?:)/i;
const TECHNICAL_METADATA =
  /(?:merge pull request|github|\bbranch\b|\b(?:feat|fix|chore)\/|\b(?:PR|RPC|ACL|RLS|CI|API)\b|#\d+)/i;

function cleanReleaseTitle(raw: string): string {
  const normalized = raw.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";

  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  let candidate = normalized;

  if (/^Merge pull request #\d+\s+from\s+\S+$/i.test(lines[0] ?? "")) {
    candidate = lines.slice(1).join(" ");
  } else if (/^Merge pull request #\d+\s+from\s+\S+\s+/i.test(candidate)) {
    const marker = candidate.search(CONVENTIONAL_MARKER);
    candidate = marker >= 0 ? candidate.slice(marker) : "";
  }

  return candidate
    .replace(CONVENTIONAL_PREFIX, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sentence(value: string): string {
  if (!value) return value;
  const capitalized = `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

/**
 * Converts deployment metadata into owner-facing language. The raw release
 * note remains available to the announcement drafting workflow, while email
 * and review surfaces never expose pull-request, branch, or repository noise.
 */
export function ownerFriendlyReleaseSummary(
  raw: string,
  language: UserLanguage,
): string {
  const source = raw.toLowerCase();
  const vi = language === "vi";

  if (
    source.includes("smart checkout") &&
    /(?:foundation|simulator|sandbox)/i.test(raw)
  ) {
    return vi
      ? "NailIQ đang chuẩn bị trải nghiệm thanh toán an toàn hơn. Bản cập nhật này chưa bật chức năng thu tiền thật."
      : "NailIQ is preparing a safer checkout experience. This update does not enable live payment collection.";
  }
  if (source.includes("capacity rescue")) {
    return vi
      ? "Khi giờ khách muốn đã hết chỗ, NailIQ có thể lưu đúng nhu cầu để salon xem và sắp xếp tiếp."
      : "When a requested time is full, NailIQ can save the customer’s exact request for salon follow-up.";
  }
  if (/\b(?:sms|text message)\b/i.test(raw)) {
    return vi
      ? "NailIQ vừa cải thiện nội dung và khả năng theo dõi trạng thái tin nhắn xác nhận."
      : "NailIQ has improved confirmation text messages and their delivery tracking.";
  }
  if (/\bemail\b/i.test(raw)) {
    return vi
      ? "NailIQ vừa cải thiện nội dung email và khả năng theo dõi trạng thái gửi."
      : "NailIQ has improved email content and delivery tracking.";
  }
  if (/\bwaitlist\b|danh sách chờ/i.test(raw)) {
    return vi
      ? "NailIQ vừa cải thiện cách salon tiếp nhận và xử lý khách trong danh sách chờ."
      : "NailIQ has improved how salons receive and manage waitlist requests.";
  }
  if (/\bbooking\b|multi-service|group scheduling/i.test(raw)) {
    return vi
      ? "NailIQ vừa cải thiện quy trình đặt hẹn và độ chính xác khi sắp xếp lịch."
      : "NailIQ has improved the booking experience and scheduling reliability.";
  }

  const cleaned = cleanReleaseTitle(raw);
  if (!vi && cleaned && !TECHNICAL_METADATA.test(cleaned)) {
    return sentence(cleaned);
  }

  return vi
    ? "NailIQ vừa có một cải tiến hệ thống. Bản nháp sẽ giải thích rõ ảnh hưởng đến salon và khách trước khi có bất kỳ thông báo nào được gửi."
    : "NailIQ has released a system improvement. The draft will explain any salon or customer impact before anything is sent.";
}
