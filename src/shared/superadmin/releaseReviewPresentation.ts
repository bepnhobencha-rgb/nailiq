import type { UserLanguage } from "@/shared/i18n/user/types";

type ReleaseKind = "fix" | "feature" | "internal" | "unknown";

export type ReleaseReviewPresentation = {
  releaseLabel: string;
  changeTitle: string;
  impact: string;
  salonAction: string;
  recommendation: string;
};

export function isReleaseReviewDecisionPath(pathname: string): boolean {
  return pathname.startsWith("/superadmin/operations/release-reviews/");
}

const CONVENTIONAL_PREFIX =
  /^(feat|fix|chore|test|ci|docs|refactor|perf)(?:\(([^)]+)\))?:\s*/i;

function releaseNumber(summary: string): string | null {
  return summary.match(/\(#(\d+)\)/)?.[1] ?? null;
}

function releaseLabel(deploymentId: string, summary: string): string {
  const number = releaseNumber(summary);
  if (number) return `#${number}`;

  const shortId = deploymentId.replace(/[^a-z0-9]/gi, "").slice(0, 8);
  return shortId ? shortId : "update";
}

function firstChangeLine(summary: string): string {
  const line = summary
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find(
      (candidate) =>
        candidate.length > 0 &&
        !candidate.startsWith("*") &&
        !/^co-authored-by:/i.test(candidate) &&
        !/^[-=]{3,}$/.test(candidate),
    );

  return (line || "NailIQ product update")
    .replace(CONVENTIONAL_PREFIX, "")
    .replace(/\s*\(#\d+\)\s*$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function releaseKind(summary: string): ReleaseKind {
  const type = summary.trim().match(CONVENTIONAL_PREFIX)?.[1]?.toLowerCase();
  if (type === "fix" || type === "perf") return "fix";
  if (type === "feat") return "feature";
  if (["chore", "test", "ci", "docs", "refactor"].includes(type ?? "")) {
    return "internal";
  }
  return "unknown";
}

function vietnameseTitle(summary: string, kind: ReleaseKind): string {
  const normalized = firstChangeLine(summary).toLowerCase();

  if (
    normalized.includes("reschedule") &&
    normalized.includes("notification") &&
    normalized.includes("time")
  ) {
    return "Email đổi lịch hiển thị rõ giờ cũ và giờ mới";
  }

  if (
    normalized.includes("localize") &&
    normalized.includes("release notice")
  ) {
    return "Thông báo cập nhật dùng ngôn ngữ đã chọn của từng Owner/Admin";
  }

  if (
    normalized.includes("release review") &&
    (normalized.includes("email") || normalized.includes("notice"))
  ) {
    return "Email duyệt cập nhật hiển thị nội dung dễ hiểu và tách riêng từng bản";
  }

  if (kind === "fix") return "NailIQ đã sửa một lỗi vận hành";
  if (kind === "feature") return "NailIQ có một cải tiến mới";
  if (kind === "internal") return "NailIQ có một cập nhật nội bộ";
  return "NailIQ có một bản cập nhật mới";
}

export function presentReleaseReview(input: {
  deploymentId: string;
  changeSummary: string;
  language: UserLanguage;
}): ReleaseReviewPresentation {
  const vi = input.language === "vi";
  const kind = releaseKind(input.changeSummary);
  const changeTitle = vi
    ? vietnameseTitle(input.changeSummary, kind)
    : firstChangeLine(input.changeSummary);

  if (kind === "fix") {
    return {
      releaseLabel: releaseLabel(input.deploymentId, input.changeSummary),
      changeTitle,
      impact: vi
        ? "Mục tiêu là sửa lỗi để thông tin chính xác hơn; không thêm thao tác mới cho salon."
        : "This corrects inaccurate behavior and does not add a new salon workflow.",
      salonAction: vi
        ? "Salon không cần làm gì."
        : "Salon owners and staff do not need to take any action.",
      recommendation: vi
        ? "Đề xuất: Không cần gửi thông báo cho salon."
        : "Recommendation: No salon notice is needed.",
    };
  }

  if (kind === "feature") {
    return {
      releaseLabel: releaseLabel(input.deploymentId, input.changeSummary),
      changeTitle,
      impact: vi
        ? "Salon có thể thấy chức năng hoặc cách sử dụng mới."
        : "Salon owners or staff may see a new feature or workflow.",
      salonAction: vi
        ? "Hãy xem bản nháp và chỉ gửi khi salon cần biết để sử dụng đúng."
        : "Review the draft and send it only if salons need the information to use NailIQ correctly.",
      recommendation: vi
        ? "Đề xuất: Xem trước nội dung rồi quyết định."
        : "Recommendation: Review the proposed notice before deciding.",
    };
  }

  if (kind === "internal") {
    return {
      releaseLabel: releaseLabel(input.deploymentId, input.changeSummary),
      changeTitle,
      impact: vi
        ? "Đây là thay đổi nội bộ, không làm thay đổi cách salon sử dụng NailIQ."
        : "This is an internal change and does not alter how salons use NailIQ.",
      salonAction: vi ? "Salon không cần làm gì." : "No salon action is required.",
      recommendation: vi
        ? "Đề xuất: Không cần gửi thông báo cho salon."
        : "Recommendation: No salon notice is needed.",
    };
  }

  return {
    releaseLabel: releaseLabel(input.deploymentId, input.changeSummary),
    changeTitle,
    impact: vi
      ? "Ảnh hưởng đến salon chưa được xác định tự động."
      : "The salon impact could not be determined automatically.",
    salonAction: vi
      ? "Hãy xem kỹ nội dung trước khi quyết định."
      : "Review the change carefully before deciding.",
    recommendation: vi
      ? "Đề xuất: Cần xem xét thủ công."
      : "Recommendation: Manual review is required.",
  };
}
