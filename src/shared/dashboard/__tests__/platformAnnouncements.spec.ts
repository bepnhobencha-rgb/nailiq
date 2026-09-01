import { describe, expect, it } from "vitest";
import {
  announcementTargetsForRole,
  isActiveAnnouncement,
} from "@/shared/dashboard/platformAnnouncements";
import {
  isPlatformAnnouncementSnoozed,
  platformAnnouncementDecisionState,
  platformAnnouncementPriority,
  shouldAutoCollapsePlatformAnnouncement,
  shouldCountPlatformAnnouncement,
  shouldShowPlatformAnnouncementBanner,
} from "@/shared/dashboard/platformAnnouncementPresentation";
import {
  localizedAnnouncementContent,
  type PlatformAnnouncement,
} from "@/shared/superadmin/announcementsTypes";

describe("platform dashboard announcements", () => {
  it("targets owners and admins as salon decision makers", () => {
    expect(announcementTargetsForRole("owner")).toEqual(["all", "owners"]);
    expect(announcementTargetsForRole("admin")).toEqual(["all", "owners"]);
  });

  it("targets operational roles as staff", () => {
    expect(announcementTargetsForRole("senior")).toEqual(["all", "staff"]);
    expect(announcementTargetsForRole("nail_tech")).toEqual(["all", "staff"]);
    expect(announcementTargetsForRole("receptionist")).toEqual(["all", "staff"]);
  });

  it("shows only published, started, and unexpired announcements", () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    expect(isActiveAnnouncement({ published_at: null, expires_at: null }, now)).toBe(false);
    expect(isActiveAnnouncement({ published_at: "2026-08-06T13:00:00.000Z", expires_at: null }, now)).toBe(false);
    expect(isActiveAnnouncement({ published_at: "2026-08-06T11:00:00.000Z", expires_at: null }, now)).toBe(true);
    expect(isActiveAnnouncement({ published_at: "2026-08-06T11:00:00.000Z", expires_at: "2026-08-06T12:00:00.000Z" }, now)).toBe(false);
    expect(isActiveAnnouncement({ published_at: "2026-08-06T11:00:00.000Z", expires_at: "2026-08-06T13:00:00.000Z" }, now)).toBe(true);
  });

  it("shows each account its selected language and defaults unknown languages to English", () => {
    const announcement: PlatformAnnouncement = {
      id: "announcement-1",
      title: "English title",
      body: "English body",
      localized: {
        en: { title: "English title", body: "English body" },
        vi: { title: "Tiêu đề tiếng Việt", body: "Nội dung tiếng Việt" },
      },
      severity: "info",
      target: "owners",
      audienceRoles: ["owner", "admin"],
      notificationMode: "in_app",
      email: {
        requested: false,
        localized: {
          en: { subject: "English subject", body: "English email" },
          vi: { subject: "Tiêu đề email", body: "Email tiếng Việt" },
        },
      },
      publishedAt: null,
      expiresAt: null,
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    };

    expect(localizedAnnouncementContent(announcement, "vi").title).toBe(
      "Tiêu đề tiếng Việt",
    );
    expect(localizedAnnouncementContent(announcement, "en").title).toBe(
      "English title",
    );
    expect(localizedAnnouncementContent(announcement, "fr").title).toBe(
      "English title",
    );
  });

  it("auto-collapses routine updates but keeps important and urgent notices visible", () => {
    expect(
      shouldAutoCollapsePlatformAnnouncement({
        severity: "info",
        notificationMode: "in_app",
      }),
    ).toBe(true);
    expect(
      shouldAutoCollapsePlatformAnnouncement({
        severity: "info",
        notificationMode: "important",
      }),
    ).toBe(false);
    expect(
      shouldAutoCollapsePlatformAnnouncement({
        severity: "urgent",
        notificationMode: "in_app",
      }),
    ).toBe(false);
    expect(
      shouldShowPlatformAnnouncementBanner({
        severity: "info",
        notificationMode: "in_app",
        seenAt: "2026-09-01T08:00:00Z",
      }),
    ).toBe(false);
    expect(
      shouldShowPlatformAnnouncementBanner({
        severity: "urgent",
        notificationMode: "important",
        seenAt: "2026-09-01T08:00:00Z",
      }),
    ).toBe(true);
  });

  it("keeps the bell focused on decisions and respects a cross-device snooze", () => {
    const routine = {
      severity: "info" as const,
      notificationMode: "in_app" as const,
      seenAt: null,
      snoozedUntil: null,
    };
    const urgent = {
      severity: "urgent" as const,
      notificationMode: "important" as const,
      seenAt: null,
      snoozedUntil: null,
    };
    expect(platformAnnouncementDecisionState(routine)).toBe("new");
    expect(platformAnnouncementDecisionState(urgent)).toBe("needs_action");
    expect(platformAnnouncementPriority(urgent)).toBeLessThan(
      platformAnnouncementPriority(routine),
    );
    expect(
      shouldCountPlatformAnnouncement(routine, { autoManageRoutine: true }),
    ).toBe(false);
    expect(
      shouldCountPlatformAnnouncement(urgent, { autoManageRoutine: true }),
    ).toBe(true);

    const snoozedUrgent = {
      ...urgent,
      snoozedUntil: "2026-09-01T10:00:00.000Z",
    };
    expect(
      isPlatformAnnouncementSnoozed(
        snoozedUrgent,
        "2026-09-01T09:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      shouldCountPlatformAnnouncement(snoozedUrgent, {
        nowIso: "2026-09-01T09:00:00.000Z",
      }),
    ).toBe(false);
  });
});
