import { z } from "zod";
import {
  ANNOUNCEMENT_SEVERITIES,
  ANNOUNCEMENT_TARGETS,
  RELEASE_AUDIENCE_ROLES,
  RELEASE_NOTIFICATION_MODES,
  type ReleaseConciergeDraft,
} from "@/shared/superadmin/announcementsTypes";

const releaseDraftSchema = z.object({
  localized: z.object({
    en: z.object({
      title: z.string().trim().min(1).max(120),
      body: z.string().trim().min(1).max(2_000),
      emailSubject: z.string().trim().min(1).max(160),
      emailBody: z.string().trim().min(1).max(4_000),
    }),
    vi: z.object({
      title: z.string().trim().min(1).max(120),
      body: z.string().trim().min(1).max(2_000),
      emailSubject: z.string().trim().min(1).max(160),
      emailBody: z.string().trim().min(1).max(4_000),
    }),
  }),
  severity: z.enum(ANNOUNCEMENT_SEVERITIES),
  target: z.enum(ANNOUNCEMENT_TARGETS),
  audienceRoles: z.array(z.enum(RELEASE_AUDIENCE_ROLES)).min(1).max(5),
  notificationMode: z.enum(RELEASE_NOTIFICATION_MODES),
  reason: z.string().trim().min(1).max(300),
});

function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function redactReleaseInput(raw: string): string {
  return raw
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email redacted]")
    .replace(/\b(?:sk|re|pk)_(?:live|test)_[A-Za-z0-9_-]+\b/g, "[token redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\b/g, "[token redacted]")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      "[internal id redacted]",
    )
    .replace(/\b[0-9a-f]{32,64}\b/gi, "[internal reference redacted]")
    .replace(/\b\d{8,15}\b/g, "[number redacted]");
}

export function parseReleaseConciergeDraft(
  raw: string,
): ReleaseConciergeDraft | null {
  const parsed = releaseDraftSchema.safeParse(extractJsonObject(raw));
  return parsed.success ? parsed.data : null;
}

export function fallbackReleaseConciergeDraft(
  changeSummary: string,
): ReleaseConciergeDraft {
  void changeSummary;
  return {
    localized: {
      en: {
        title: "A NailIQ improvement is ready",
        body: "What's new: NailIQ has an improvement ready for review.\n\nWhy it helps: The change is intended to make salon work clearer or more reliable.\n\nWhat you need to do: Please replace this safe fallback with the exact operator-facing benefit before publishing.",
        emailSubject: "A NailIQ improvement for your salon",
        emailBody: "Hello,\n\nNailIQ has an improvement ready for review.\n\nWhy it helps: The change is intended to make salon work clearer or more reliable.\n\nWhat you need to do: Please replace this safe fallback with the exact operator-facing benefit before publishing.\n\nNeed help? Call 778-868-0738 or email support@nailiq.ca.",
      },
      vi: {
        title: "NailIQ vừa có một cải tiến mới",
        body: "Có gì mới: NailIQ có một cải tiến đang chờ xem lại.\n\nLợi ích: Thay đổi này nhằm giúp công việc tại salon rõ ràng hoặc ổn định hơn.\n\nBạn cần làm gì: Vui lòng thay nội dung dự phòng này bằng lợi ích cụ thể, dễ hiểu trước khi đăng.",
        emailSubject: "NailIQ vừa có một cải tiến dành cho salon của bạn",
        emailBody: "Xin chào,\n\nNailIQ có một cải tiến đang chờ xem lại.\n\nLợi ích: Thay đổi này nhằm giúp công việc tại salon rõ ràng hoặc ổn định hơn.\n\nBạn cần làm gì: Vui lòng thay nội dung dự phòng này bằng lợi ích cụ thể, dễ hiểu trước khi đăng.\n\nCần hỗ trợ? Gọi 778-868-0738 hoặc email support@nailiq.ca.",
      },
    },
    severity: "info",
    target: "owners",
    audienceRoles: ["owner", "admin"],
    notificationMode: "in_app",
    reason:
      "Safe fallback: separate English and Vietnamese owner drafts; no email is sent.",
  };
}
