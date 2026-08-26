"use client";

import { useState } from "react";

import { Card } from "@/components/ui/Card";
import type { LoadFinancialReportResult } from "@/shared/reports/loadFinancialReport";
import { formatCurrency } from "@/shared/lib/currencyFormat";
import { financialCoverageMetricLabel, financialCoverageReasonLabel, financialCoverageStateLabel } from "@/shared/reports/financialCoveragePresentation";

type Props = { slug: string; result: LoadFinancialReportResult; language: "en" | "vi" };

function amount(value: number | null, currency: string): string {
  if (value === null) return "—";
  const formatted = formatCurrency(Math.abs(value), currency);
  return formatted ? `${value < 0 ? "−" : ""}${formatted}` : `${value} ${currency}`;
}

export function FinancialEvidencePanel({ slug, result, language }: Props) {
  const [downloading, setDownloading] = useState<"csv" | "pdf" | null>(null);
  const [downloadError, setDownloadError] = useState(false);
  const vi = language === "vi";
  if (!result.ok) {
    return (
      <Card variant="default" padding="md">
        <h2 className="text-sm font-semibold text-nq-foreground">{vi ? "Bằng chứng tài chính" : "Financial evidence"}</h2>
        <p role="status" className="mt-2 text-sm text-nq-muted">
          {vi ? "Báo cáo bằng chứng hiện chưa khả dụng." : "The evidence report is currently unavailable."}
        </p>
      </Card>
    );
  }
  const { report, exportToken } = result;
  const download = async (format: "csv" | "pdf") => {
    setDownloading(format); setDownloadError(false);
    try {
      const response = await fetch("/api/dashboard/financial-report", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, format, report, exportToken }),
      });
      if (!response.ok) throw new Error("download_failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `financial-evidence-${report.range.localFrom}-${report.range.localToExclusive}.${format}`;
      anchor.click(); URL.revokeObjectURL(url);
    } catch { setDownloadError(true); } finally { setDownloading(null); }
  };
  const totals = [
    [vi ? "Ước tính trước thuế" : "Booked subtotal estimate", report.totals.bookedSubtotalCents],
    [vi ? "Ước tính thuế" : "Booked tax estimate", report.totals.bookedTaxCents],
    [vi ? "Tổng ước tính lịch hẹn" : "Booked total estimate", report.totals.bookedTotalCents],
    [vi ? "Đã thu có biên nhận" : "Receipt-backed gross", report.totals.collectedGrossCents],
    [vi ? "Tip có bằng chứng" : "Evidenced tips", report.totals.tipCents],
    [vi ? "Hoàn tiền có biên nhận" : "Receipt-backed refunds", report.totals.refundCents],
    [vi ? "Dòng tiền ròng có bằng chứng" : "Evidenced net movement", report.totals.collectedNetCents],
    [vi ? "Hoa hồng ước tính" : "Estimated commission", report.totals.commissionCents],
  ] as const;
  return (
    <Card variant="default" padding="md">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-nq-foreground">{vi ? "Bằng chứng tài chính" : "Financial evidence"}</h2>
          <p className="mt-1 text-xs text-nq-muted">
            {vi ? "Ước tính lịch hẹn được tách riêng khỏi khoản tiền có biên nhận nhà cung cấp." : "Booking estimates are kept separate from provider receipt-backed money."}
          </p>
          <p className="mt-1 text-[11px] text-nq-muted">
            {report.range.localFrom} – {report.range.localToExclusive} ({vi ? "không gồm ngày cuối" : "end exclusive"}) · {report.salon.timezone} · {report.salon.currency} · {vi ? "bằng chứng đến" : "evidence cutoff"} {report.range.effectiveUtcToExclusive} · {vi ? "ảnh chụp dữ liệu lúc" : "snapshot as of"} {report.dataAsOf}
          </p>
        </div>
        <div className="flex gap-2">
          {(["csv", "pdf"] as const).map((format) => (
            <button key={format} type="button" disabled={downloading !== null} onClick={() => void download(format)}
              className="rounded-md border border-nq-border px-3 py-1.5 text-xs font-medium text-nq-foreground disabled:opacity-50">
              {downloading === format ? (vi ? "Đang tạo…" : "Preparing…") : `${vi ? "Tải" : "Export"} ${format.toUpperCase()}`}
            </button>
          ))}
        </div>
      </div>
      {downloadError ? <p role="alert" className="mt-2 text-xs text-nq-error">{vi ? "Không thể xuất đúng ảnh chụp báo cáo này. Hãy tải lại báo cáo rồi thử lại." : "This exact report snapshot could not be exported. Reload the report and try again."}</p> : null}
      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {totals.map(([label, value]) => <div key={label} className="rounded-md bg-nq-surface px-3 py-2"><dt className="text-xs text-nq-muted">{label}</dt><dd className="mt-1 font-semibold tabular-nums text-nq-foreground">{amount(value, report.salon.currency)}</dd></div>)}
      </dl>
      <div className="mt-4 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
        {Object.entries(report.coverage).map(([metric, coverage]) => (
          <div key={metric} className="rounded-md border border-nq-border px-3 py-2">
            <p className="font-medium text-nq-foreground">{financialCoverageMetricLabel(metric as keyof typeof report.coverage, language)}: {financialCoverageStateLabel(coverage.state, language)}</p>
            <p className="mt-1 text-nq-muted">{coverage.includedRows} {vi ? "có bằng chứng" : "included"}; {coverage.excludedRows} {vi ? "thiếu" : "excluded"}</p>
            {coverage.reasonCodes.length ? <p className="mt-1 break-words text-nq-muted">{coverage.reasonCodes.map((code) => financialCoverageReasonLabel(code, language)).join(" · ")}</p> : null}
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-nq-muted">
        {vi ? "Tip chỉ hiển thị từ bằng chứng đã xác minh. Hoa hồng là ước tính từ doanh thu dịch vụ sau giảm giá, không gồm thuế hoặc tip, và không phải bảng lương hay lệnh chi trả." : "Tips appear only from verified evidence. Commission is an estimate based on after-discount service revenue, excluding tax and tips, and is not payroll or payout authority."}
      </p>
      <p className="mt-2 break-all font-mono text-[10px] text-nq-muted">{vi ? "Mã báo cáo" : "Report fingerprint"}: {report.reportFingerprint}</p>
    </Card>
  );
}
