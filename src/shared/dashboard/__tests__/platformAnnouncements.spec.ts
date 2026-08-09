import { describe, expect, it } from "vitest";
import {
  announcementTargetsForRole,
  isActiveAnnouncement,
} from "@/shared/dashboard/platformAnnouncements";
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
});
