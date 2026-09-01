import type { DashboardPlatformAnnouncement } from "@/shared/dashboard/platformAnnouncements";

export type PlatformAnnouncementDecisionState =
  | "needs_action"
  | "new"
  | "handled";

export function shouldAutoCollapsePlatformAnnouncement(
  announcement: Pick<
    DashboardPlatformAnnouncement,
    "severity" | "notificationMode"
  >,
): boolean {
  return (
    announcement.severity === "info" &&
    announcement.notificationMode !== "important"
  );
}

export function shouldShowPlatformAnnouncementBanner(
  announcement: Pick<
    DashboardPlatformAnnouncement,
    "severity" | "notificationMode" | "seenAt"
  > & { snoozedUntil?: string | null },
  options: { autoManageRoutine?: boolean; nowIso?: string } = {},
): boolean {
  if (isPlatformAnnouncementSnoozed(announcement, options.nowIso)) return false;
  if (announcement.severity !== "info") return true;
  if (options.autoManageRoutine && shouldAutoCollapsePlatformAnnouncement(announcement)) {
    return false;
  }
  return announcement.seenAt === null;
}

export function isPlatformAnnouncementSnoozed(
  announcement: { snoozedUntil?: string | null },
  nowIso = new Date().toISOString(),
): boolean {
  if (!announcement.snoozedUntil) return false;
  const snoozedUntilMs = Date.parse(announcement.snoozedUntil);
  const nowMs = Date.parse(nowIso);
  return Number.isFinite(snoozedUntilMs) && Number.isFinite(nowMs) && snoozedUntilMs > nowMs;
}

export function platformAnnouncementDecisionState(
  announcement: Pick<
    DashboardPlatformAnnouncement,
    "severity" | "notificationMode" | "seenAt"
  >,
): PlatformAnnouncementDecisionState {
  if (
    announcement.severity !== "info" ||
    announcement.notificationMode === "important"
  ) {
    return "needs_action";
  }
  return announcement.seenAt ? "handled" : "new";
}

export function platformAnnouncementPriority(
  announcement: Pick<
    DashboardPlatformAnnouncement,
    "severity" | "notificationMode" | "seenAt"
  >,
): number {
  if (announcement.severity === "urgent") return 0;
  if (announcement.severity === "warning") return 1;
  if (announcement.notificationMode === "important") return 2;
  return announcement.seenAt ? 4 : 3;
}

export function shouldCountPlatformAnnouncement(
  announcement: Pick<
    DashboardPlatformAnnouncement,
    "severity" | "notificationMode" | "seenAt"
  > & { snoozedUntil?: string | null },
  options: { autoManageRoutine?: boolean; nowIso?: string } = {},
): boolean {
  if (isPlatformAnnouncementSnoozed(announcement, options.nowIso)) return false;
  if (platformAnnouncementDecisionState(announcement) === "needs_action") return true;
  return announcement.seenAt === null && !options.autoManageRoutine;
}
