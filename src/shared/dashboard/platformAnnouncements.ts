import type { SalonMemberRole } from "@/shared/lib/salonMemberRole";
import { createClient } from "@/shared/lib/supabase/server";
import {
  isAnnouncementSeverity,
  isAnnouncementTarget,
  isReleaseNotificationMode,
  type PlatformAnnouncement,
} from "@/shared/superadmin/announcementsTypes";
import {
  audienceIncludesMemberRole,
  normalizeReleaseAudienceRoles,
} from "@/shared/superadmin/releaseAudience";

type AnnouncementRow = {
  id: string;
  title: string;
  body: string;
  title_en: string | null;
  body_en: string | null;
  title_vi: string | null;
  body_vi: string | null;
  audience_roles: unknown;
  notification_mode: string;
  email_requested: boolean;
  email_subject_en: string | null;
  email_body_en: string | null;
  email_subject_vi: string | null;
  email_body_vi: string | null;
  severity: string;
  target: string;
  published_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export function announcementTargetsForRole(
  role: SalonMemberRole,
): Array<"all" | "owners" | "staff"> {
  return role === "owner" || role === "admin"
    ? ["all", "owners"]
    : ["all", "staff"];
}

export function isActiveAnnouncement(
  row: Pick<AnnouncementRow, "published_at" | "expires_at">,
  now: Date,
): boolean {
  const publishedAt = row.published_at
    ? new Date(row.published_at).getTime()
    : Number.NaN;
  const expiresAt = row.expires_at
    ? new Date(row.expires_at).getTime()
    : null;

  return (
    Number.isFinite(publishedAt) &&
    publishedAt <= now.getTime() &&
    (expiresAt === null || (Number.isFinite(expiresAt) && expiresAt > now.getTime()))
  );
}

function mapAnnouncement(row: AnnouncementRow): PlatformAnnouncement | null {
  if (!isAnnouncementSeverity(row.severity) || !isAnnouncementTarget(row.target)) {
    return null;
  }
  const titleEn = row.title_en?.trim() || row.title;
  const bodyEn = row.body_en?.trim() || row.body;
  const titleVi = row.title_vi?.trim() || titleEn;
  const bodyVi = row.body_vi?.trim() || bodyEn;
  const audienceRoles = normalizeReleaseAudienceRoles(
    Array.isArray(row.audience_roles) ? row.audience_roles : [],
  );
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    localized: {
      en: { title: titleEn, body: bodyEn },
      vi: { title: titleVi, body: bodyVi },
    },
    severity: row.severity,
    target: row.target,
    audienceRoles,
    notificationMode: isReleaseNotificationMode(row.notification_mode)
      ? row.notification_mode
      : "in_app",
    email: {
      requested: row.email_requested === true,
      localized: {
        en: {
          subject: row.email_subject_en?.trim() || titleEn,
          body: row.email_body_en?.trim() || bodyEn,
        },
        vi: {
          subject: row.email_subject_vi?.trim() || titleVi,
          body: row.email_body_vi?.trim() || bodyVi,
        },
      },
    },
    publishedAt: row.published_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function loadDashboardAnnouncements(
  role: SalonMemberRole,
  now = new Date(),
): Promise<PlatformAnnouncement[]> {
  try {
    const supabase = await createClient();
    const { data, error } = (await supabase
      .from("platform_announcements")
      .select(
        "id, title, body, title_en, body_en, title_vi, body_vi, audience_roles, notification_mode, email_requested, email_subject_en, email_body_en, email_subject_vi, email_body_vi, severity, target, published_at, expires_at, created_at, updated_at" as never,
      )
      .in("target", announcementTargetsForRole(role))
      .not("published_at", "is", null)
      .order("published_at", { ascending: false })
      .limit(20)) as {
        data: AnnouncementRow[] | null;
        error: unknown;
      };

    if (error) {
      console.error("[platform-announcements/dashboard] query failed", error);
      return [];
    }

    return (data ?? [])
      .filter((row) => isActiveAnnouncement(row, now))
      .filter((row) =>
        audienceIncludesMemberRole(
          normalizeReleaseAudienceRoles(
            Array.isArray(row.audience_roles) ? row.audience_roles : [],
          ),
          role,
        ),
      )
      .map(mapAnnouncement)
      .filter((row): row is PlatformAnnouncement => row !== null)
      .slice(0, 3);
  } catch (error) {
    console.error("[platform-announcements/dashboard] unexpected", error);
    return [];
  }
}
