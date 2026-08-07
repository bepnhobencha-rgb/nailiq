"use client";

import { useSyncExternalStore } from "react";
import type { PlatformAnnouncement } from "@/shared/superadmin/announcementsTypes";

const STYLE = {
  info: "border-sky-500/45 bg-sky-500/10 text-nq-foreground",
  warning: "border-amber-500/55 bg-amber-500/12 text-nq-foreground",
  urgent: "border-nq-error/55 bg-nq-error/12 text-nq-foreground",
} as const;

function storageKey(announcement: PlatformAnnouncement): string {
  return `nailiq:announcement:dismissed:${announcement.id}:${announcement.updatedAt}`;
}

export function PlatformAnnouncementBanner({
  announcements,
  language,
}: {
  announcements: PlatformAnnouncement[];
  language: string;
}) {
  const dismissedIds = useSyncExternalStore(
    (onStoreChange) => {
      window.addEventListener("storage", onStoreChange);
      window.addEventListener("nailiq-announcement-dismissed", onStoreChange);
      return () => {
        window.removeEventListener("storage", onStoreChange);
        window.removeEventListener("nailiq-announcement-dismissed", onStoreChange);
      };
    },
    () => announcements
      .filter((announcement) => localStorage.getItem(storageKey(announcement)) === "1")
      .map((announcement) => announcement.id)
      .join(","),
    () => "",
  );
  const dismissed = new Set(dismissedIds ? dismissedIds.split(",") : []);
  const visible = announcements.filter((announcement) => !dismissed.has(announcement.id));
  if (visible.length === 0) return null;

  function dismiss(announcement: PlatformAnnouncement) {
    localStorage.setItem(storageKey(announcement), "1");
    window.dispatchEvent(new Event("nailiq-announcement-dismissed"));
  }

  return (
    <div className="mx-4 mt-3 flex flex-col gap-2 sm:mx-6 sm:mt-4">
      {visible.map((announcement) => (
        <section
          key={announcement.id}
          className={`rounded-2xl border px-4 py-3 shadow-sm ${STYLE[announcement.severity]}`}
          role={announcement.severity === "urgent" ? "alert" : "status"}
          aria-live={announcement.severity === "urgent" ? "assertive" : "polite"}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="font-semibold leading-snug">{announcement.title}</p>
              <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-nq-muted">
                {announcement.body}
              </p>
            </div>
            <button
              type="button"
              onClick={() => dismiss(announcement)}
              className="shrink-0 rounded-lg border border-current/20 px-2.5 py-1.5 text-xs font-semibold hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary"
              aria-label={`${language === "vi" ? "Ẩn thông báo" : "Dismiss announcement"}: ${announcement.title}`}
            >
              {language === "vi" ? "Đã hiểu" : "Dismiss"}
            </button>
          </div>
        </section>
      ))}
    </div>
  );
}
