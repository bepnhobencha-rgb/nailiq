import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  announcementStorageKey,
  PlatformAnnouncementBanner,
  shouldAutoDismissAnnouncement,
} from "@/components/dashboard/PlatformAnnouncementBanner";
import type { PlatformAnnouncement } from "@/shared/superadmin/announcementsTypes";

function announcement(
  overrides: Partial<PlatformAnnouncement> = {},
): PlatformAnnouncement {
  return {
    id: "notice-1",
    title: "Improved reliability",
    body: "No action required.",
    localized: {
      en: {
        title: "Improved reliability",
        body: "No action required.",
      },
      vi: {
        title: "Cải thiện độ tin cậy",
        body: "Bạn không cần làm gì.",
      },
    },
    severity: "info",
    target: "owners",
    audienceRoles: ["owner"],
    notificationMode: "in_app",
    email: {
      requested: false,
      localized: {
        en: { subject: "Improved reliability", body: "No action required." },
        vi: { subject: "Cải thiện độ tin cậy", body: "Bạn không cần làm gì." },
      },
    },
    publishedAt: "2026-09-06T00:00:00.000Z",
    expiresAt: null,
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T01:00:00.000Z",
    ...overrides,
  };
}

describe("PlatformAnnouncementBanner", () => {
  it("places a full-size acknowledgement action below the notice content", () => {
    const html = renderToStaticMarkup(
      createElement(PlatformAnnouncementBanner, {
        announcements: [announcement()],
        language: "vi",
        storageScope: "salon-1:user-1",
      }),
    );

    expect(html).toContain("Cải thiện độ tin cậy");
    expect(html).toContain("Đã hiểu");
    expect(html).toContain("min-h-11");
    expect(html.indexOf("Bạn không cần làm gì.")).toBeLessThan(
      html.indexOf("Đã hiểu"),
    );
  });

  it("auto-dismisses only routine informational notices", () => {
    expect(shouldAutoDismissAnnouncement(announcement())).toBe(true);
    expect(
      shouldAutoDismissAnnouncement(
        announcement({ notificationMode: "important" }),
      ),
    ).toBe(false);
    expect(
      shouldAutoDismissAnnouncement(announcement({ severity: "warning" })),
    ).toBe(false);
    expect(
      shouldAutoDismissAnnouncement(announcement({ severity: "urgent" })),
    ).toBe(false);
  });

  it("scopes dismissal storage to the salon account and user", () => {
    const notice = announcement();
    expect(announcementStorageKey(notice, "salon-1:user-1")).not.toBe(
      announcementStorageKey(notice, "salon-1:user-2"),
    );
    expect(announcementStorageKey(notice, "salon-1:user-1")).toContain(
      notice.updatedAt,
    );
  });
});
