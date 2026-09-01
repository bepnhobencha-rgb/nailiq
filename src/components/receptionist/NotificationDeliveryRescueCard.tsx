"use client";

import Link from "next/link";
import { useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  ListChecks,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import type {
  NotificationDeliveryIssue,
  NotificationDeliveryRescueSummary,
} from "@/shared/dashboard/loadReceptionistCenterData";

type Props = {
  slug: string;
  language: "en" | "vi";
  summary: NotificationDeliveryRescueSummary;
  refreshing: boolean;
  onRefresh(): void;
  onOpenBooking(bookingId: string, bookingDate: string): void;
  onOpenWaitlist(): void;
};

function issueKindLabel(
  issue: NotificationDeliveryIssue,
  language: "en" | "vi",
): string {
  const labels: Record<string, [string, string]> = {
    booking_confirmation: ["Xác nhận lịch hẹn", "Booking confirmation"],
    booking_reminder: ["Nhắc lịch hẹn", "Booking reminder"],
    owner_booking_new: ["Báo lịch mới cho salon", "New-booking salon alert"],
    owner_booking_reschedule: [
      "Báo đổi lịch cho salon",
      "Reschedule salon alert",
    ],
    customer_booking_reschedule: [
      "Báo đổi lịch cho khách",
      "Customer reschedule notice",
    ],
    customer_booking_cancel: [
      "Báo hủy lịch cho khách",
      "Customer cancellation notice",
    ],
    owner_waitlist_joined: [
      "Báo khách mới vào Waitlist",
      "New Waitlist salon alert",
    ],
    customer_waitlist_offer: [
      "Mời khách nhận chỗ trống",
      "Waitlist opening offer",
    ],
  };
  const label = labels[issue.notificationKind];
  return label
    ? label[language === "vi" ? 0 : 1]
    : language === "vi"
      ? "Thông báo lịch hẹn"
      : "Appointment notice";
}

export function notificationDeliveryResolutionCopy(
  resolution: NotificationDeliveryIssue["resolution"],
  language: "en" | "vi",
): string {
  const vi = language === "vi";
  if (resolution === "auto_retry_scheduled") {
    return vi
      ? "NailIQ đang tự gửi lại an toàn. Không cần gửi tay."
      : "NailIQ is retrying safely. Do not resend manually.";
  }
  if (resolution === "reconcile_required") {
    return vi
      ? "Kết quả chưa rõ. Phải đối soát trước khi gửi lại để tránh gửi trùng."
      : "Outcome is unknown. Reconcile before resending to avoid duplicates.";
  }
  return vi
    ? "Mở hồ sơ và dùng kênh liên lạc dự phòng đã xác minh."
    : "Open the record and use a verified fallback contact channel.";
}

export function NotificationDeliveryRescueCard({
  slug,
  language,
  summary,
  refreshing,
  onRefresh,
  onOpenBooking,
  onOpenWaitlist,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const vi = language === "vi";
  const attentionCount =
    summary.smsAttentionCount +
    summary.emailAttentionCount +
    summary.waitlistAttentionCount;
  const hasConfigIssue =
    !summary.smsOutboundEnabled ||
    !summary.emailOutboundEnabled ||
    !summary.smsA2pRegistered;
  const hasDeliveryIssue = !summary.available || attentionCount > 0;

  if (summary.available && !hasConfigIssue && attentionCount === 0) return null;

  const issues: string[] = [];
  if (!summary.available) {
    issues.push(
      vi
        ? "Chưa đọc được trạng thái gửi. Booking vẫn được lưu; hãy kiểm tra lại."
        : "Delivery status is unavailable. Bookings remain saved; check again.",
    );
  } else {
    if (!summary.smsOutboundEnabled) {
      issues.push(
        vi
          ? summary.emailOutboundEnabled
            ? "SMS đang tắt theo cài đặt salon; Email vẫn hoạt động."
            : "SMS đang tắt theo cài đặt salon."
          : summary.emailOutboundEnabled
            ? "SMS is off by salon setting; Email remains available."
            : "SMS is off by salon setting.",
      );
    } else if (!summary.smsA2pRegistered) {
      issues.push(
        vi
          ? "SMS đến số Mỹ chưa sẵn sàng (A2P)."
          : "SMS to US numbers is not ready (A2P).",
      );
    }
    if (!summary.emailOutboundEnabled) {
      issues.push(
        vi
          ? "Email đang tắt theo cài đặt salon."
          : "Email is off by salon setting.",
      );
    }
    if (summary.smsAttentionCount > 0) {
      issues.push(
        vi
          ? `${summary.smsAttentionCount} SMS cần xử lý trong 24 giờ qua.`
          : `${summary.smsAttentionCount} SMS ${summary.smsAttentionCount === 1 ? "needs" : "need"} attention in the last 24 hours.`,
      );
    }
    if (summary.emailAttentionCount > 0) {
      issues.push(
        vi
          ? `${summary.emailAttentionCount} email cần xử lý trong 24 giờ qua.`
          : `${summary.emailAttentionCount} ${summary.emailAttentionCount === 1 ? "email needs" : "emails need"} attention in the last 24 hours.`,
      );
    }
    if (summary.waitlistAttentionCount > 0) {
      issues.push(
        vi
          ? `${summary.waitlistAttentionCount} thông báo Waitlist cần xử lý.`
          : `${summary.waitlistAttentionCount} Waitlist notifications need attention.`,
      );
    }
  }

  return (
    <section
      data-testid="notification-delivery-rescue-card"
      role={hasDeliveryIssue ? "alert" : "status"}
      aria-live="polite"
      className="shrink-0 border-b border-nq-warning/40 bg-nq-warning/10 px-[var(--pad-nq-section-mobile)] pb-3 pt-14 text-nq-foreground sm:py-3 md:px-6 lg:pr-36"
    >
      <div className="mx-auto w-full max-w-[var(--max-nq-desktop)]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            {hasDeliveryIssue ? (
              <AlertTriangle
                className="mt-0.5 h-5 w-5 shrink-0 text-nq-warning"
                aria-hidden="true"
              />
            ) : (
              <ShieldCheck
                className="mt-0.5 h-5 w-5 shrink-0 text-nq-info"
                aria-hidden="true"
              />
            )}
            <div className="min-w-0">
              <p className="text-base font-semibold">
                {hasDeliveryIssue
                  ? vi
                    ? "Có thông báo cần xử lý — lịch hẹn vẫn an toàn"
                    : "Notifications need attention — bookings remain safe"
                  : vi
                    ? "Kênh gửi tin đang được giới hạn theo cài đặt"
                    : "A messaging channel is limited by salon settings"}
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-nq-muted">
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap gap-2">
            {summary.issues.length > 0 ? (
              <Button
                variant="primary"
                size="lg"
                onClick={() => setExpanded((value) => !value)}
                aria-expanded={expanded}
                aria-controls="notification-delivery-rescue-details"
                leftIcon={<ListChecks className="h-4 w-4" />}
                rightIcon={
                  expanded ? (
                    <ChevronUp className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )
                }
              >
                {vi
                  ? `Xem ${summary.issues.length} trường hợp`
                  : `Review ${summary.issues.length} cases`}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="lg"
              onClick={onRefresh}
              loading={refreshing}
              leftIcon={<RefreshCw className="h-4 w-4" />}
            >
              {vi ? "Kiểm tra lại" : "Check again"}
            </Button>
            {hasConfigIssue ? (
              <Link
                href={`/dashboard/${encodeURIComponent(slug)}/settings`}
                className="inline-flex min-h-12 items-center justify-center rounded-full bg-nq-surface px-6 text-base font-medium text-nq-foreground ring-1 ring-inset ring-nq-border transition-colors hover:bg-nq-surface/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary"
              >
                {vi ? "Cài đặt gửi tin" : "Messaging settings"}
              </Link>
            ) : null}
          </div>
        </div>

        {expanded && summary.issues.length > 0 ? (
          <div
            id="notification-delivery-rescue-details"
            data-testid="notification-delivery-rescue-details"
            className="mt-3 grid gap-2 border-t border-nq-warning/30 pt-3 md:grid-cols-2"
          >
            {summary.issues.map((issue) => (
              <article
                key={issue.issueKey}
                className="rounded-2xl border border-nq-border bg-nq-surface p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={issue.channel === "sms" ? "info" : "neutral"}
                    size="sm"
                  >
                    {issue.channel === "sms" ? "SMS" : "Email"}
                  </Badge>
                  <Badge
                    variant={
                      issue.resolution === "reconcile_required"
                        ? "warning"
                        : issue.resolution === "auto_retry_scheduled"
                          ? "info"
                          : "danger"
                    }
                    size="sm"
                    dot
                  >
                    {issue.status}
                  </Badge>
                </div>
                <p className="mt-2 text-sm font-semibold">
                  {issueKindLabel(issue, language)}
                </p>
                <p className="mt-1 text-sm text-nq-muted">
                  {notificationDeliveryResolutionCopy(issue.resolution, language)}
                </p>
                {issue.destination === "booking" &&
                issue.bookingId &&
                issue.bookingDate ? (
                  <Button
                    variant="secondary"
                    size="lg"
                    className="mt-3"
                    leftIcon={<CalendarDays className="h-4 w-4" />}
                    onClick={() =>
                      onOpenBooking(issue.bookingId!, issue.bookingDate!)
                    }
                  >
                    {vi ? "Mở đúng lịch hẹn" : "Open this booking"}
                  </Button>
                ) : issue.destination === "waitlist" ? (
                  <Button
                    variant="secondary"
                    size="lg"
                    className="mt-3"
                    leftIcon={<ListChecks className="h-4 w-4" />}
                    onClick={onOpenWaitlist}
                  >
                    {vi ? "Mở Waitlist" : "Open Waitlist"}
                  </Button>
                ) : null}
              </article>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
