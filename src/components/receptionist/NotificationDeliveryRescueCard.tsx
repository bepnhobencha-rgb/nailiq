import Link from "next/link";
import { AlertTriangle, RefreshCw } from "lucide-react";

import type { NotificationDeliveryRescueSummary } from "@/shared/dashboard/loadReceptionistCenterData";

type Props = {
  slug: string;
  language: "en" | "vi";
  summary: NotificationDeliveryRescueSummary;
  refreshing: boolean;
  onRefresh(): void;
};

export function NotificationDeliveryRescueCard({
  slug,
  language,
  summary,
  refreshing,
  onRefresh,
}: Props) {
  const issues: string[] = [];
  if (!summary.available) {
    issues.push(
      language === "vi"
        ? "Chưa đọc được trạng thái gửi thông báo."
        : "Notification delivery status is unavailable.",
    );
  } else {
    if (!summary.smsOutboundEnabled) {
      issues.push(language === "vi" ? "SMS đang tắt." : "SMS is turned off.");
    } else if (!summary.smsA2pRegistered) {
      issues.push(
        language === "vi"
          ? "SMS đến số Mỹ chưa sẵn sàng (A2P)."
          : "SMS to US numbers is not ready (A2P).",
      );
    }
    if (!summary.emailOutboundEnabled) {
      issues.push(
        language === "vi" ? "Email đang tắt." : "Email is turned off.",
      );
    }
    if (summary.smsAttentionCount > 0) {
      issues.push(
        language === "vi"
          ? `${summary.smsAttentionCount} SMS cần kiểm tra trong 24 giờ qua.`
          : `${summary.smsAttentionCount} SMS need review in the last 24 hours.`,
      );
    }
    if (summary.emailAttentionCount > 0) {
      issues.push(
        language === "vi"
          ? `${summary.emailAttentionCount} email cần kiểm tra trong 24 giờ qua.`
          : `${summary.emailAttentionCount} emails need review in the last 24 hours.`,
      );
    }
    if (summary.waitlistAttentionCount > 0) {
      issues.push(
        language === "vi"
          ? `${summary.waitlistAttentionCount} thông báo Waitlist cần xử lý.`
          : `${summary.waitlistAttentionCount} Waitlist notifications need attention.`,
      );
    }
  }

  if (issues.length === 0) return null;

  return (
    <section
      data-testid="notification-delivery-rescue-card"
      role="status"
      aria-live="polite"
      className="shrink-0 border-b border-amber-500/40 bg-amber-50 px-[var(--pad-nq-section-mobile)] py-3 text-amber-950 md:px-6"
    >
      <div className="mx-auto flex w-full max-w-[var(--max-nq-desktop)] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-base font-semibold">
              {language === "vi"
                ? "Có khách có thể chưa nhận được thông báo"
                : "Some customers may not have received a notification"}
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-amber-700/30 bg-white px-4 text-sm font-semibold text-amber-950 disabled:opacity-60"
          >
            <RefreshCw
              className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"}
              aria-hidden="true"
            />
            {language === "vi" ? "Kiểm tra lại" : "Check again"}
          </button>
          <Link
            href={`/dashboard/${encodeURIComponent(slug)}/settings`}
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-amber-900 px-4 text-sm font-semibold text-white"
          >
            {language === "vi" ? "Mở cài đặt gửi tin" : "Open messaging settings"}
          </Link>
        </div>
      </div>
    </section>
  );
}
