"use client";

import { useMemo, useState, useTransition } from "react";
import { Check, Clock3, ShieldCheck, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Toggle } from "@/components/ui/Toggle";
import {
  dismissPlatformAnnouncement,
  snoozePlatformAnnouncement,
  updatePlatformNotificationPreference,
} from "@/shared/dashboard/platformAnnouncementReceiptActions";
import {
  isPlatformAnnouncementSnoozed,
  platformAnnouncementDecisionState,
  platformAnnouncementPriority,
} from "@/shared/dashboard/platformAnnouncementPresentation";
import type { DashboardPlatformAnnouncement } from "@/shared/dashboard/platformAnnouncements";
import { localizedAnnouncementContent } from "@/shared/superadmin/announcementsTypes";

export function PlatformAnnouncementCenter({
  slug,
  language,
  announcements,
  autoManageRoutine,
  nowIso,
}: {
  slug: string;
  language: string;
  announcements: DashboardPlatformAnnouncement[];
  autoManageRoutine: boolean;
  nowIso: string;
}) {
  const vi = language === "vi";
  const [items, setItems] = useState(announcements);
  const [autoManage, setAutoManage] = useState(autoManageRoutine);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [preferencePending, startPreferenceTransition] = useTransition();
  const [, startItemTransition] = useTransition();

  const orderedItems = useMemo(
    () =>
      [...items].sort(
        (left, right) =>
          platformAnnouncementPriority(left) - platformAnnouncementPriority(right),
      ),
    [items],
  );
  const needsDecision = orderedItems.filter(
    (item) =>
      platformAnnouncementDecisionState(item) === "needs_action" &&
      !isPlatformAnnouncementSnoozed(item, nowIso),
  );
  const cocoTracking = orderedItems.filter((item) =>
    isPlatformAnnouncementSnoozed(item, nowIso),
  );
  const updates = orderedItems.filter(
    (item) =>
      platformAnnouncementDecisionState(item) !== "needs_action" &&
      !isPlatformAnnouncementSnoozed(item, nowIso),
  );

  function acknowledge(announcement: DashboardPlatformAnnouncement) {
    setErrorId(null);
    setFeedback(null);
    setItems((current) => current.filter((item) => item.id !== announcement.id));
    startItemTransition(async () => {
      const result = await dismissPlatformAnnouncement(slug, announcement.id);
      if (!result.ok) {
        setErrorId(announcement.id);
        setItems((current) =>
          current.some((item) => item.id === announcement.id)
            ? current
            : [announcement, ...current],
        );
        return;
      }
      setFeedback(
        vi
          ? "Đã đóng nhắc nhở và đồng bộ trên các thiết bị."
          : "Reminder closed and synced across devices.",
      );
    });
  }

  function snooze(announcement: DashboardPlatformAnnouncement) {
    setErrorId(null);
    setFeedback(null);
    const snoozedUntil = new Date(
      Date.parse(nowIso) + 60 * 60 * 1_000,
    ).toISOString();
    setItems((current) =>
      current.map((item) =>
        item.id === announcement.id ? { ...item, snoozedUntil } : item,
      ),
    );
    startItemTransition(async () => {
      const result = await snoozePlatformAnnouncement(slug, announcement.id);
      if (!result.ok) {
        setErrorId(announcement.id);
        setItems((current) =>
          current.map((item) =>
            item.id === announcement.id
              ? { ...item, snoozedUntil: announcement.snoozedUntil }
              : item,
          ),
        );
        return;
      }
      setFeedback(
        vi
          ? "Coco sẽ đưa việc này trở lại sau 1 giờ."
          : "Coco will bring this back in 1 hour.",
      );
    });
  }

  function updateAutoManage(next: boolean) {
    const previous = autoManage;
    setAutoManage(next);
    setFeedback(null);
    startPreferenceTransition(async () => {
      const result = await updatePlatformNotificationPreference(slug, next);
      if (!result.ok) {
        setAutoManage(previous);
        setFeedback(
          vi
            ? "Chưa lưu được lựa chọn. Vui lòng thử lại."
            : "Could not save this choice. Please try again.",
        );
        return;
      }
      setFeedback(
        next
          ? vi
            ? "Coco sẽ tự thu gọn các cập nhật thường; tiền, booking và gửi tin vẫn cần đúng quyền duyệt."
            : "Coco will organize routine updates; money, bookings, and messages still keep their approval gates."
          : vi
            ? "Cập nhật thường sẽ hiện trên Dashboard trong 8 giây."
            : "Routine updates will appear on the Dashboard for 8 seconds.",
      );
    });
  }

  function renderItem(
    announcement: DashboardPlatformAnnouncement,
    mode: "decision" | "tracking" | "update",
  ) {
    const content = localizedAnnouncementContent(announcement, language);
    return (
      <Card key={announcement.id} variant="bordered" padding="md">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  mode === "decision"
                    ? "warning"
                    : mode === "tracking"
                      ? "info"
                      : "success"
                }
                state="subtle"
                dot
              >
                {mode === "decision"
                  ? vi
                    ? "Cần quyết định"
                    : "Decision needed"
                  : mode === "tracking"
                    ? vi
                      ? "Coco đang theo dõi"
                      : "Coco is tracking"
                    : vi
                      ? "Đã sắp xếp an toàn"
                      : "Safely organized"}
              </Badge>
            </div>
            <p className="font-semibold text-nq-foreground">{content.title}</p>
            <p className="mt-1 whitespace-pre-line text-sm leading-6 text-nq-muted">
              {content.body}
            </p>
            <p className="mt-2 text-xs leading-5 text-nq-muted">
              {mode === "decision"
                ? vi
                  ? "Coco giữ việc này nổi bật cho đến khi bạn quyết định."
                  : "Coco keeps this visible until you decide."
                : mode === "tracking"
                  ? vi
                    ? "Việc này sẽ tự quay lại khi hết thời gian tạm hoãn."
                    : "This will return automatically when the snooze ends."
                  : vi
                    ? "Chỉ sắp xếp thông báo; không gọi provider, thu tiền hoặc gửi tin."
                    : "Notification organization only; no provider, payment, or message action."}
            </p>
            {errorId === announcement.id ? (
              <p className="mt-2 text-xs font-medium text-nq-error" role="alert">
                {vi
                  ? "Chưa lưu được. Trạng thái cũ đã được khôi phục."
                  : "Could not save. The previous state was restored."}
              </p>
            ) : null}
          </div>
          <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:shrink-0 sm:justify-end">
            {mode === "decision" ? (
              <Button
                variant="ghost"
                size="sm"
                className="border border-nq-border"
                leftIcon={<Clock3 className="h-4 w-4" />}
                onClick={() => snooze(announcement)}
              >
                {vi ? "Nhắc lại 1 giờ" : "Remind in 1 hour"}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="border border-nq-border"
              leftIcon={<Check className="h-4 w-4" />}
              onClick={() => acknowledge(announcement)}
            >
              {mode === "decision"
                ? vi
                  ? "Tôi đã xử lý"
                  : "I handled it"
                : vi
                  ? "Đã hiểu"
                  : "Got it"}
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <section className="mb-6" aria-labelledby="product-updates-title">
      <div className="mb-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-nq-primary">
          Coco Decision Center
        </p>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2
              id="product-updates-title"
              className="text-xl font-semibold text-nq-foreground"
            >
              {vi ? "Chỉ hiện việc thật sự cần bạn" : "Only what truly needs you"}
            </h2>
            <p className="mt-1 text-sm text-nq-muted">
              {vi
                ? "Coco ưu tiên việc cần quyết định, theo dõi việc đã hoãn và dọn các cập nhật thường."
                : "Coco prioritizes decisions, tracks snoozed work, and organizes routine updates."}
            </p>
          </div>
          <Badge variant={needsDecision.length > 0 ? "warning" : "success"}>
            {needsDecision.length > 0
              ? vi
                ? `${needsDecision.length} việc cần bạn`
                : `${needsDecision.length} need you`
              : vi
                ? "Không có việc gấp"
                : "Nothing urgent"}
          </Badge>
        </div>
      </div>

      <Card variant="bordered" padding="md" className="mb-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span
              className="mt-0.5 rounded-full bg-nq-primary/10 p-2 text-nq-primary"
              aria-hidden
            >
              <Sparkles className="h-4 w-4" />
            </span>
            <div>
              <p className="font-semibold text-nq-foreground">
                {vi
                  ? "Để Coco tự sắp xếp cập nhật thường"
                  : "Let Coco organize routine updates"}
              </p>
              <p className="mt-1 text-xs leading-5 text-nq-muted">
                {vi
                  ? "An toàn: chỉ quản lý cách hiển thị. Không cấp quyền booking, gửi tin, provider hoặc thanh toán."
                  : "Safe: display management only. No booking, messaging, provider, or payment permission."}
              </p>
            </div>
          </div>
          <Toggle
            checked={autoManage}
            loading={preferencePending}
            onChange={updateAutoManage}
            aria-label={
              vi
                ? "Coco tự sắp xếp cập nhật thường"
                : "Coco auto-manages routine updates"
            }
          />
        </div>
      </Card>

      {feedback ? (
        <div
          className="mb-4 flex items-start gap-2 rounded-2xl border border-nq-success/30 bg-nq-success/10 px-4 py-3 text-sm text-nq-foreground"
          role="status"
          aria-live="polite"
        >
          <ShieldCheck
            className="mt-0.5 h-4 w-4 shrink-0 text-nq-success"
            aria-hidden
          />
          <span>{feedback}</span>
        </div>
      ) : null}

      {orderedItems.length === 0 ? (
        <Card variant="bordered" padding="lg" className="text-center">
          <ShieldCheck className="mx-auto h-7 w-7 text-nq-success" aria-hidden />
          <p className="mt-3 font-semibold text-nq-foreground">
            {vi ? "Coco đã dọn xong" : "Coco is all caught up"}
          </p>
          <p className="mt-1 text-sm text-nq-muted">
            {vi
              ? "Hiện không có quyết định nào cần bạn."
              : "There are no decisions waiting for you."}
          </p>
        </Card>
      ) : (
        <div className="space-y-6">
          {needsDecision.length > 0 ? (
            <div>
              <h3 className="mb-3 text-sm font-semibold text-nq-foreground">
                {vi ? "Cần bạn quyết định" : "Needs your decision"}
              </h3>
              <div className="space-y-3">
                {needsDecision.map((item) => renderItem(item, "decision"))}
              </div>
            </div>
          ) : null}
          {cocoTracking.length > 0 ? (
            <div>
              <h3 className="mb-3 text-sm font-semibold text-nq-foreground">
                {vi ? "Coco đang theo dõi" : "Coco is tracking"}
              </h3>
              <div className="space-y-3">
                {cocoTracking.map((item) => renderItem(item, "tracking"))}
              </div>
            </div>
          ) : null}
          {updates.length > 0 ? (
            <div>
              <h3 className="mb-3 text-sm font-semibold text-nq-foreground">
                {vi ? "Cập nhật đã được sắp xếp" : "Organized updates"}
              </h3>
              <div className="space-y-3">
                {updates.map((item) => renderItem(item, "update"))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
