"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Check, Clock3, X } from "lucide-react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/Button";
import {
  dismissPlatformAnnouncement,
  markPlatformAnnouncementSeen,
  snoozePlatformAnnouncement,
} from "@/shared/dashboard/platformAnnouncementReceiptActions";
import {
  platformAnnouncementDecisionState,
  shouldAutoCollapsePlatformAnnouncement,
  shouldShowPlatformAnnouncementBanner,
} from "@/shared/dashboard/platformAnnouncementPresentation";
import type { DashboardPlatformAnnouncement } from "@/shared/dashboard/platformAnnouncements";
import { localizedAnnouncementContent } from "@/shared/superadmin/announcementsTypes";

const STYLE = {
  info: "border-sky-500/45 bg-sky-500/10 text-nq-foreground",
  warning: "border-amber-500/55 bg-amber-500/12 text-nq-foreground",
  urgent: "border-nq-error/55 bg-nq-error/12 text-nq-foreground",
} as const;

const INFORMATION_AUTO_COLLAPSE_MS = 8_000;

export function PlatformAnnouncementBanner({
  announcements,
  language,
  slug,
  autoManageRoutine,
  nowIso,
}: {
  announcements: DashboardPlatformAnnouncement[];
  language: string;
  slug: string;
  autoManageRoutine: boolean;
  nowIso: string;
}) {
  const vi = language === "vi";
  const router = useRouter();
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const [failedId, setFailedId] = useState<string | null>(null);
  const scheduledIdsRef = useRef<Set<string>>(new Set());
  const [, startTransition] = useTransition();

  useEffect(() => {
    const nowMs = Date.parse(nowIso);
    const nextWakeMs = announcements.reduce<number | null>((earliest, announcement) => {
      const wakeMs = announcement.snoozedUntil
        ? Date.parse(announcement.snoozedUntil)
        : Number.NaN;
      if (!Number.isFinite(wakeMs) || wakeMs <= nowMs) return earliest;
      return earliest === null || wakeMs < earliest ? wakeMs : earliest;
    }, null);
    if (nextWakeMs === null) return;
    const timer = window.setTimeout(
      () => router.refresh(),
      Math.max(250, nextWakeMs - nowMs + 250),
    );
    return () => window.clearTimeout(timer);
  }, [announcements, nowIso, router]);

  useEffect(() => {
    const timers = announcements
      .filter(
        (announcement) =>
          shouldAutoCollapsePlatformAnnouncement(announcement) &&
          announcement.seenAt === null &&
          !scheduledIdsRef.current.has(announcement.id),
      )
      .map((announcement) => {
        scheduledIdsRef.current.add(announcement.id);
        return window.setTimeout(() => {
          setHiddenIds((current) => new Set(current).add(announcement.id));
          startTransition(async () => {
            const result = await markPlatformAnnouncementSeen(slug, announcement.id);
            if (!result.ok) {
              setFailedId(announcement.id);
              setHiddenIds((current) => {
                const next = new Set(current);
                next.delete(announcement.id);
                return next;
              });
              scheduledIdsRef.current.delete(announcement.id);
            }
          });
        }, autoManageRoutine ? 0 : INFORMATION_AUTO_COLLAPSE_MS);
      });

    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [announcements, autoManageRoutine, slug]);

  const visible = announcements.filter(
    (announcement) =>
      !hiddenIds.has(announcement.id) &&
      shouldShowPlatformAnnouncementBanner(announcement, {
        autoManageRoutine,
        nowIso,
      }),
  );
  if (visible.length === 0) return null;

  function dismiss(announcement: DashboardPlatformAnnouncement) {
    setFailedId(null);
    setHiddenIds((current) => new Set(current).add(announcement.id));
    startTransition(async () => {
      const result = await dismissPlatformAnnouncement(slug, announcement.id);
      if (!result.ok) {
        setFailedId(announcement.id);
        setHiddenIds((current) => {
          const next = new Set(current);
          next.delete(announcement.id);
          return next;
        });
      }
    });
  }

  function snooze(announcement: DashboardPlatformAnnouncement) {
    setFailedId(null);
    setHiddenIds((current) => new Set(current).add(announcement.id));
    startTransition(async () => {
      const result = await snoozePlatformAnnouncement(slug, announcement.id);
      if (!result.ok) {
        setFailedId(announcement.id);
        setHiddenIds((current) => {
          const next = new Set(current);
          next.delete(announcement.id);
          return next;
        });
      }
    });
  }

  return (
    <div className="mx-4 mt-3 flex flex-col gap-2 sm:ml-6 sm:mr-36 sm:mt-4">
      {visible.map((announcement) => {
        const content = localizedAnnouncementContent(announcement, language);
        const autoCollapses = shouldAutoCollapsePlatformAnnouncement(announcement);
        const decisionState = platformAnnouncementDecisionState(announcement);
        return (
        <section
          key={announcement.id}
          className={`rounded-2xl border px-4 py-3 shadow-sm ${STYLE[announcement.severity]}`}
          role={announcement.severity === "urgent" ? "alert" : "status"}
          aria-live={announcement.severity === "urgent" ? "assertive" : "polite"}
          data-testid="platform-announcement-banner"
        >
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-nq-primary">
                {decisionState === "needs_action"
                  ? vi
                    ? "Cần quyết định"
                    : "Decision needed"
                  : vi
                    ? "Cập nhật từ NailIQ"
                    : "NailIQ update"}
              </p>
              <p className="mt-1 font-semibold leading-snug">{content.title}</p>
              <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-nq-muted">
                {content.body}
              </p>
              {autoCollapses ? (
                <p className="mt-2 text-xs text-nq-muted">
                  {vi
                    ? "Thông báo này sẽ tự thu vào Nhật ký."
                    : "This notice will collapse into Activity."}
                </p>
              ) : null}
              {failedId === announcement.id ? (
                <p className="mt-2 text-xs font-medium text-nq-error" role="alert">
                  {vi
                    ? "Chưa lưu được trạng thái. Vui lòng thử lại."
                    : "Could not save this yet. Please try again."}
                </p>
              ) : null}
            </div>
            <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:shrink-0 sm:justify-end">
              {decisionState === "needs_action" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => snooze(announcement)}
                  className="border border-current/20"
                  leftIcon={<Clock3 className="h-4 w-4" />}
                >
                  {vi ? "Nhắc lại sau 1 giờ" : "Remind me in 1 hour"}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => dismiss(announcement)}
                className="border border-current/20"
                leftIcon={decisionState === "needs_action" ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
                aria-label={`${vi ? "Đóng thông báo" : "Dismiss announcement"}: ${content.title}`}
              >
                {decisionState === "needs_action"
                  ? vi
                    ? "Tôi đã xử lý"
                    : "I handled it"
                  : vi
                    ? "Đã hiểu"
                    : "Got it"}
              </Button>
            </div>
          </div>
        </section>
        );
      })}
    </div>
  );
}
