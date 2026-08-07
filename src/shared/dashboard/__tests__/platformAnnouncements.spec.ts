import { describe, expect, it } from "vitest";
import {
  announcementTargetsForRole,
  isActiveAnnouncement,
} from "@/shared/dashboard/platformAnnouncements";

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
});
