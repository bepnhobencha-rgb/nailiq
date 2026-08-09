import { z } from "zod";
import {
  ANNOUNCEMENT_SEVERITIES,
  ANNOUNCEMENT_TARGETS,
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
  const clean = changeSummary.replace(/\s+/g, " ").trim().slice(0, 700);
  return {
    localized: {
      en: {
        title: "A NailIQ improvement is ready",
        body: `What's new: ${clean}\n\nWhat you need to do: No action is required unless the message above says otherwise.`,
        emailSubject: "A NailIQ improvement for your salon",
        emailBody: `Hello,\n\nNailIQ has an improvement for your salon.\n\n${clean}\n\nWhat you need to do: No action is required unless the message above says otherwise.\n\nNeed help? Call 778-868-0738 or email support@nailiq.ca.`,
      },
      vi: {
        title: "NailIQ vừa có một cải tiến mới",
        body: `Có gì mới: ${clean}\n\nBạn cần làm gì: Không cần thao tác, trừ khi nội dung trên có hướng dẫn khác.`,
        emailSubject: "NailIQ vừa có một cải tiến dành cho salon của bạn",
        emailBody: `Xin chào,\n\nNailIQ vừa có một cải tiến dành cho salon của bạn.\n\n${clean}\n\nBạn cần làm gì: Không cần thao tác, trừ khi nội dung trên có hướng dẫn khác.\n\nCần hỗ trợ? Gọi 778-868-0738 hoặc email support@nailiq.ca.`,
      },
    },
    severity: "info",
    target: "owners",
    notificationMode: "in_app",
    reason:
      "Safe fallback: separate English and Vietnamese owner drafts; no email is sent.",
  };
}
