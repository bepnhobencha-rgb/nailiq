"use client";

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/Button";
import {
  localizedAnnouncementContent,
  type PlatformAnnouncement,
} from "@/shared/superadmin/announcementsTypes";

const STYLE = {
  info: "border-sky-500/45 bg-sky-500/10 text-nq-foreground",
  warning: "border-amber-500/55 bg-amber-500/12 text-nq-foreground",
  urgent: "border-nq-error/55 bg-nq-error/12 text-nq-foreground",
} as const;

const ROUTINE_ANNOUNCEMENT_VISIBILITY_MS = 8_000;
const DISMISSED_EVENT = "nailiq-announcement-dismissed";

export function announcementStorageKey(
  announcement: PlatformAnnouncement,
  storageScope: string,
): string {
  return `nailiq:announcement:dismissed:${storageScope}:${announcement.id}:${announcement.updatedAt}`;
}

export function shouldAutoDismissAnnouncement(
  announcement: PlatformAnnouncement,
): boolean {
  return (
    announcement.severity === "info" &&
    announcement.notificationMode !== "important"
  );
}

function isStoredAsDismissed(
  announcement: PlatformAnnouncement,
  storageScope: string,
): boolean {
  try {
    return (
      localStorage.getItem(announcementStorageKey(announcement, storageScope)) ===
      "1"
    );
  } catch {
    return false;
  }
}

function storeDismissed(
  announcement: PlatformAnnouncement,
  storageScope: string,
): void {
  try {
    localStorage.setItem(announcementStorageKey(announcement, storageScope), "1");
  } catch {
    // Storage can be unavailable in privacy-restricted browsers. The custom
    // event still hides the notice for the current page session.
  }
}

function AnnouncementItem({
  announcement,
  language,
  onDismiss,
}: {
  announcement: PlatformAnnouncement;
  language: string;
  onDismiss: (announcement: PlatformAnnouncement) => void;
}) {
  const [pauseAutoDismiss, setPauseAutoDismiss] = useState(false);
  const content = localizedAnnouncementContent(announcement, language);
  const autoDismiss = shouldAutoDismissAnnouncement(announcement);

  useEffect(() => {
    if (!autoDismiss || pauseAutoDismiss) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const startTimerWhenVisible = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (document.visibilityState === "visible") {
        timer = setTimeout(
          () => onDismiss(announcement),
          ROUTINE_ANNOUNCEMENT_VISIBILITY_MS,
        );
      }
    };

    startTimerWhenVisible();
    document.addEventListener("visibilitychange", startTimerWhenVisible);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", startTimerWhenVisible);
    };
  }, [announcement, autoDismiss, onDismiss, pauseAutoDismiss]);

  return (
    <section
      className={`rounded-2xl border px-4 py-3 shadow-sm ${STYLE[announcement.severity]}`}
      role={announcement.severity === "urgent" ? "alert" : "status"}
      aria-live={announcement.severity === "urgent" ? "assertive" : "polite"}
      onFocusCapture={() => setPauseAutoDismiss(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setPauseAutoDismiss(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onDismiss(announcement);
        }
      }}
    >
      <div className="min-w-0">
        <p className="font-semibold leading-snug">{content.title}</p>
        <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-nq-muted">
          {content.body}
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          size="md"
          className="min-h-11"
          onClick={() => onDismiss(announcement)}
          aria-label={`${language === "vi" ? "Ẩn thông báo" : "Dismiss announcement"}: ${content.title}`}
        >
          {language === "vi" ? "Đã hiểu" : "Got it"}
        </Button>
        {autoDismiss ? (
          <span className="text-xs text-nq-muted" aria-hidden="true">
            {language === "vi"
              ? "Thông báo này sẽ tự ẩn sau vài giây"
              : "This notice will hide automatically"}
          </span>
        ) : null}
      </div>
    </section>
  );
}

export function PlatformAnnouncementBanner({
  announcements,
  language,
  storageScope,
}: {
  announcements: PlatformAnnouncement[];
  language: string;
  storageScope: string;
}) {
  const [sessionDismissed, setSessionDismissed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const dismissedIds = useSyncExternalStore(
    (onStoreChange) => {
      window.addEventListener("storage", onStoreChange);
      window.addEventListener(DISMISSED_EVENT, onStoreChange);
      return () => {
        window.removeEventListener("storage", onStoreChange);
        window.removeEventListener(DISMISSED_EVENT, onStoreChange);
      };
    },
    () => announcements
      .filter((announcement) => isStoredAsDismissed(announcement, storageScope))
      .map((announcement) => announcement.id)
      .join(","),
    () => "",
  );
  const dismissed = new Set(dismissedIds ? dismissedIds.split(",") : []);
  const visible = announcements.filter(
    (announcement) =>
      !dismissed.has(announcement.id) &&
      !sessionDismissed.has(announcement.id),
  );

  const dismiss = useCallback((announcement: PlatformAnnouncement) => {
    storeDismissed(announcement, storageScope);
    setSessionDismissed((current) => {
      const next = new Set(current);
      next.add(announcement.id);
      return next;
    });
    window.dispatchEvent(new Event(DISMISSED_EVENT));
  }, [storageScope]);

  if (visible.length === 0) return null;

  return (
    <div className="mx-4 mt-3 flex flex-col gap-2 sm:mx-6 sm:mt-4">
      {visible.map((announcement) => (
        <AnnouncementItem
          key={announcement.id}
          announcement={announcement}
          language={language}
          onDismiss={dismiss}
        />
      ))}
    </div>
  );
}
