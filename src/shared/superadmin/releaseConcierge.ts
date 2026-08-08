import { z } from "zod";
import {
  ANNOUNCEMENT_SEVERITIES,
  ANNOUNCEMENT_TARGETS,
  RELEASE_NOTIFICATION_MODES,
  type ReleaseConciergeDraft,
} from "@/shared/superadmin/announcementsTypes";

const releaseDraftSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(2_000),
  severity: z.enum(ANNOUNCEMENT_SEVERITIES),
  target: z.enum(ANNOUNCEMENT_TARGETS),
  notificationMode: z.enum(RELEASE_NOTIFICATION_MODES),
  emailSubject: z.string().trim().min(1).max(160),
  emailBody: z.string().trim().min(1).max(4_000),
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
    title: "NailIQ product update / Cập nhật NailIQ",
    body: `What's new: ${clean}\n\nCó gì mới: ${clean}`,
    severity: "info",
    target: "owners",
    notificationMode: "in_app",
    emailSubject: "NailIQ product update / Cập nhật NailIQ",
    emailBody: `NailIQ has an update for your salon.\n\n${clean}\n\nNailIQ có một cập nhật dành cho salon của bạn.`,
    reason: "Safe fallback: in-app draft for owners; no email is sent.",
  };
}
