import type { SalonMemberRole } from "@/shared/lib/salonMemberRole";
import { createClient } from "@/shared/lib/supabase/server";
import {
  isAnnouncementSeverity,
  isAnnouncementTarget,
  type PlatformAnnouncement,
} from "@/shared/superadmin/announcementsTypes";

type AnnouncementRow = {
  id: string;
  title: string;
  body: string;
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
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    severity: row.severity,
    target: row.target,
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
        "id, title, body, severity, target, published_at, expires_at, created_at, updated_at" as never,
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
      .map(mapAnnouncement)
      .filter((row): row is PlatformAnnouncement => row !== null)
      .slice(0, 3);
  } catch (error) {
    console.error("[platform-announcements/dashboard] unexpected", error);
    return [];
  }
}
