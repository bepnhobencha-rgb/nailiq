"use client";

import { useSyncExternalStore } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  MailCheck,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import {
  bulkEmailCampaignMetrics,
  type BulkEmailCampaignReport,
} from "@/shared/marketing/bulkEmailCampaignReport";

const MOBILE_DRAWER_QUERY = "(max-width: 767px)";

function subscribeMobileDrawer(callback: () => void) {
  const query = window.matchMedia(MOBILE_DRAWER_QUERY);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

function mobileDrawerSnapshot() {
  return window.matchMedia(MOBILE_DRAWER_QUERY).matches;
}

function mobileDrawerServerSnapshot() {
  return false;
}

export type ReportCampaign = {
  id: string;
  name: string;
  subject: string;
  audienceCount: number;
  excludedNoConsent: number;
  excludedInvalidEmail: number;
  excludedOptout: number;
  excludedProviderSuppression: number;
  excludedDuplicate: number;
  createdAt: string;
  report: BulkEmailCampaignReport;
};

function csvCell(value: string | number) {
  const text = String(value);
  const spreadsheetSafe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${spreadsheetSafe.replace(/"/g, '""')}"`;
}

export function BulkEmailCampaignReportDrawer({
  campaign,
  onClose,
}: {
  campaign: ReportCampaign | null;
  onClose: () => void;
}) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const t = (en: string, viText: string) => (vi ? viText : en);
  const isMobile = useSyncExternalStore(
    subscribeMobileDrawer,
    mobileDrawerSnapshot,
    mobileDrawerServerSnapshot,
  );

  if (!campaign) return null;
  const activeCampaign = campaign;
  const { report } = activeCampaign;
  const metrics = bulkEmailCampaignMetrics(report);
  const excludedTotal =
    activeCampaign.excludedNoConsent
    + activeCampaign.excludedInvalidEmail
    + activeCampaign.excludedOptout
    + activeCampaign.excludedProviderSuppression
    + activeCampaign.excludedDuplicate;
  const percent = (value: number | null) => value === null
    ? "—"
    : new Intl.NumberFormat(vi ? "vi-VN" : "en-US", {
        style: "percent",
        minimumFractionDigits: 1,
        maximumFractionDigits: 2,
      }).format(value);
  const number = (value: number) => value.toLocaleString(vi ? "vi-VN" : "en-US");
  const date = new Intl.DateTimeFormat(vi ? "vi-VN" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(activeCampaign.createdAt));

  const recommendation = {
    healthy: t(
      "Delivery health is good. Keep suppressions on before the next campaign.",
      "Sức khỏe gửi tốt. Hãy giữ danh sách chặn trước chiến dịch tiếp theo.",
    ),
    wait_for_receipts: t(
      "Some providers still owe a final receipt. Wait before calling the final delivery rate complete.",
      "Một số email vẫn chờ kết quả cuối. Chưa nên xem tỷ lệ giao là kết quả cuối cùng.",
    ),
    review_failures: t(
      "Review failed or unknown outcomes before starting another campaign.",
      "Kiểm tra các kết quả lỗi hoặc chưa rõ trước khi chạy chiến dịch khác.",
    ),
    pause_for_complaints: t(
      "A complaint was recorded. Keep delivery paused and review consent immediately.",
      "Đã ghi nhận khiếu nại. Giữ gửi ở trạng thái tắt và kiểm tra đồng ý nhận email ngay.",
    ),
    bounce_threshold_reached: t(
      "Bounce rate reached the 2% safety threshold. Clean the audience before sending again.",
      "Tỷ lệ bounce đã chạm ngưỡng an toàn 2%. Cần làm sạch người nhận trước khi gửi lại.",
    ),
    not_started: t(
      "No provider delivery outcome has been recorded yet.",
      "Chưa ghi nhận kết quả gửi từ nhà cung cấp.",
    ),
  }[metrics.recommendation];

  function downloadCsv() {
    const rows: Array<[string, string | number]> = [
      ["campaign", activeCampaign.name],
      ["subject", activeCampaign.subject],
      ["created_at", activeCampaign.createdAt],
      ["audience", report.audienceCount],
      ["delivered", report.counts.delivered],
      ["provider_accepted_pending", report.counts.providerAccepted],
      ["bounced", report.counts.bounced],
      ["suppressed", report.counts.suppressed],
      ["failed", report.counts.failed],
      ["unknown", report.counts.unknown],
      ["complained", report.counts.complained],
      ["global_suppressions", report.globalSuppressionCount],
      ["excluded_no_consent", activeCampaign.excludedNoConsent],
      ["excluded_optout", activeCampaign.excludedOptout],
      ["excluded_invalid_email", activeCampaign.excludedInvalidEmail],
      ["excluded_duplicate", activeCampaign.excludedDuplicate],
      ["excluded_provider_suppression", activeCampaign.excludedProviderSuppression],
      ["delivered_rate", metrics.deliveredRate === null ? "" : metrics.deliveredRate],
      ["bounce_rate", metrics.bounceRate === null ? "" : metrics.bounceRate],
    ];
    const csv = ["metric,value", ...rows.map(([key, value]) =>
      `${csvCell(key)},${csvCell(value)}`
    )].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `nailiq-campaign-${activeCampaign.id}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Drawer
      isOpen
      onClose={onClose}
      variant={isMobile ? "bottom" : "right"}
      size="lg"
      title={t("Campaign report", "Báo cáo chiến dịch")}
      description={`${activeCampaign.name} · ${date}`}
      closeButtonLabel={t("Close report", "Đóng báo cáo")}
      footer={report.available ? (
        <Button
          variant="secondary"
          fullWidth
          leftIcon={<Download className="h-4 w-4" aria-hidden />}
          onClick={downloadCsv}
        >
          {t("Download CSV report", "Tải báo cáo CSV")}
        </Button>
      ) : null}
    >
      {!report.available ? (
        <div role="status" className="rounded-xl border border-nq-warning/30 bg-nq-warning/10 p-4">
          <p className="font-semibold text-nq-foreground">
            {t("Detailed report is not installed yet", "Báo cáo chi tiết chưa được cài")}
          </p>
          <p className="mt-1 text-sm text-nq-muted">
            {t(
              "Campaign delivery remains unchanged. Apply the reporting migration before relying on these totals.",
              "Việc gửi chiến dịch không thay đổi. Cần áp migration báo cáo trước khi sử dụng các số liệu này.",
            )}
          </p>
        </div>
      ) : (
        <div className="grid gap-5">
          <section aria-labelledby="delivery-summary-heading">
            <div className="flex items-center gap-2">
              <MailCheck className="h-5 w-5 text-nq-primary" aria-hidden />
              <h3 id="delivery-summary-heading" className="font-semibold text-nq-foreground">
                {t("Delivery truth", "Kết quả gửi thực tế")}
              </h3>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {[
                {
                  label: t("Audience", "Người nhận"),
                  value: number(report.audienceCount),
                  icon: Users,
                },
                {
                  label: t("Delivered", "Đã giao"),
                  value: number(report.counts.delivered),
                  icon: CheckCircle2,
                },
                {
                  label: t("Awaiting final receipt", "Chờ kết quả cuối"),
                  value: number(metrics.pendingFinalReceiptCount),
                  icon: Clock3,
                },
                {
                  label: t("Bounced", "Email bị trả lại"),
                  value: number(report.counts.bounced),
                  icon: AlertTriangle,
                },
              ].map(({ label, value, icon: Icon }) => (
                <div key={label} className="rounded-xl border border-nq-border bg-nq-bg/30 p-3">
                  <div className="flex items-center gap-2 text-xs text-nq-muted">
                    <Icon className="h-4 w-4" aria-hidden />
                    <span>{label}</span>
                  </div>
                  <p className="mt-2 text-2xl font-semibold tabular-nums text-nq-foreground">{value}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs leading-5 text-nq-muted">
              {t(
                `Delivered rate ${percent(metrics.deliveredRate)}. “Delivered” means the recipient mail server accepted the message; Inbox placement is not guaranteed.`,
                `Tỷ lệ đã giao ${percent(metrics.deliveredRate)}. “Đã giao” nghĩa là máy chủ email người nhận đã chấp nhận; không bảo đảm email nằm trong Inbox.`,
              )}
            </p>
          </section>

          <section className="rounded-xl border border-nq-border bg-nq-bg/30 p-4" aria-labelledby="safety-heading">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-nq-success" aria-hidden />
              <h3 id="safety-heading" className="font-semibold text-nq-foreground">
                {t("Audience safety", "An toàn người nhận")}
              </h3>
            </div>
            <dl className="mt-3 grid gap-2 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-nq-muted">{t("Bounce rate", "Tỷ lệ bounce")}</dt><dd className="tabular-nums text-nq-foreground">{percent(metrics.bounceRate)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-nq-muted">{t("Complaints", "Khiếu nại")}</dt><dd className="tabular-nums text-nq-foreground">{number(report.counts.complained)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-nq-muted">{t("Need review", "Cần kiểm tra")}</dt><dd className="tabular-nums text-nq-foreground">{number(metrics.needsReviewCount)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-nq-muted">{t("Protected from future sends", "Đã chặn gửi lại")}</dt><dd className="tabular-nums text-nq-foreground">{number(report.globalSuppressionCount)}</dd></div>
            </dl>
          </section>

          <section aria-labelledby="excluded-heading">
            <h3 id="excluded-heading" className="font-semibold text-nq-foreground">
              {t(`${number(excludedTotal)} excluded before sending`, `${number(excludedTotal)} đã loại trước khi gửi`)}
            </h3>
            <dl className="mt-3 grid gap-2 text-sm">
              {[
                [t("No marketing consent", "Chưa đồng ý quảng cáo"), activeCampaign.excludedNoConsent],
                [t("Opted out", "Đã từ chối nhận"), activeCampaign.excludedOptout],
                [t("Invalid email", "Email không hợp lệ"), activeCampaign.excludedInvalidEmail],
                [t("Duplicate", "Email trùng"), activeCampaign.excludedDuplicate],
                [t("Previously suppressed", "Đã bị chặn trước đó"), activeCampaign.excludedProviderSuppression],
              ].map(([label, value]) => (
                <div key={String(label)} className="flex justify-between gap-3 border-b border-nq-border/60 pb-2 last:border-0">
                  <dt className="text-nq-muted">{label}</dt>
                  <dd className="tabular-nums text-nq-foreground">{number(Number(value))}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="rounded-xl border border-nq-primary/30 bg-nq-primary/10 p-4" aria-labelledby="coco-heading">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-nq-primary" aria-hidden />
              <h3 id="coco-heading" className="font-semibold text-nq-foreground">
                {t("Coco recommends", "Coco đề xuất")}
              </h3>
            </div>
            <p className="mt-2 text-sm leading-6 text-nq-foreground">{recommendation}</p>
          </section>

          <section className="rounded-xl border border-nq-border bg-nq-bg/30 p-4" aria-labelledby="attribution-heading">
            <h3 id="attribution-heading" className="font-semibold text-nq-foreground">
              {t("Bookings and revenue", "Lịch hẹn và doanh thu")}
            </h3>
            <p className="mt-2 text-sm leading-6 text-nq-muted">
              {t(
                "This campaign used a standard booking link, so NailIQ cannot prove which clicks, bookings, or revenue came from it. These values are intentionally not estimated.",
                "Chiến dịch này dùng link đặt hẹn thông thường nên NailIQ chưa thể chứng minh click, lịch hẹn hoặc doanh thu nào đến từ chiến dịch. Hệ thống cố ý không ước đoán các số này.",
              )}
            </p>
          </section>
        </div>
      )}
    </Drawer>
  );
}
