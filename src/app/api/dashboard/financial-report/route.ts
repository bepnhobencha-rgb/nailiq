import { NextResponse } from "next/server";

import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";
import { isReleaseFeatureVisible } from "@/shared/features/platformFeatureFlags";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { renderFinancialReportCsv } from "@/shared/reports/financialReportCsv";
import { verifyFinancialReportSnapshot } from "@/shared/reports/financialReportExportToken";
import { assertFinancialReportExportable } from "@/shared/reports/financialReportExportLimits";
import { parseFinancialReportDto } from "@/shared/reports/financialReportParser";
import { renderFinancialReportPdf } from "@/shared/reports/financialReportPdf";
import { checkFinancialReportRateLimits } from "@/shared/reports/financialReportRateLimit";
import { loadFinancialReport } from "@/shared/reports/loadFinancialReport";
import { readJsonObjectWithLimit } from "@/shared/security/readJsonObjectWithLimit";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_EXPORT_BODY_BYTES = 4 * 1024 * 1024;

function noStore(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug")?.trim() ?? "";
  const from = url.searchParams.get("from")?.trim() ?? "";
  const to = url.searchParams.get("to")?.trim() ?? "";
  if (!slug || slug.length > 100) return noStore(400, { ok: false, error: "invalid_request" });
  const result = await loadFinancialReport(slug, from, to);
  if (result.ok) return noStore(200, result);
  const status = result.error === "unauthorized" ? 401
    : result.error === "forbidden" || result.error === "feature_not_enabled" ? 403
      : result.error === "rate_limited" ? 429
      : result.error === "report_too_large" ? 413
      : result.error === "invalid_range" ? 400 : 503;
  return noStore(status, result);
}

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return noStore(403, { ok: false, error: "forbidden_origin" });
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") return noStore(415, { ok: false, error: "invalid_content_type" });
  const body = await readJsonObjectWithLimit(request, MAX_EXPORT_BODY_BYTES);
  if (!body) return noStore(413, { ok: false, error: "invalid_or_oversized_body" });
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  const format = body.format === "csv" || body.format === "pdf" ? body.format : null;
  const exportToken = typeof body.exportToken === "string" && body.exportToken.length <= 256 ? body.exportToken : "";
  if (!slug || slug.length > 100 || !format || !exportToken) return noStore(400, { ok: false, error: "invalid_request" });

  try {
    const resolved = await resolveSalonForDashboard(slug);
    if (!resolved) return noStore(401, { ok: false, error: "unauthorized" });
    if (!resolved.viewerUserId || !isOwnerOrAdmin(resolved.role)) return noStore(403, { ok: false, error: "forbidden" });
    if (!(await isReleaseFeatureVisible(resolved.salon, "advanced_reports"))) {
      return noStore(403, { ok: false, error: "feature_not_enabled" });
    }
    const limiter = await checkFinancialReportRateLimits(resolved.viewerUserId, resolved.salon.id, "export");
    if (limiter !== "allowed") return noStore(limiter === "rate_limited" ? 429 : 503, { ok: false, error: limiter });
    const report = parseFinancialReportDto(body.report);
    assertFinancialReportExportable(report);
    if (report.salon.id !== resolved.salon.id || !verifyFinancialReportSnapshot(report, resolved.viewerUserId, exportToken)) {
      return noStore(409, { ok: false, error: "report_snapshot_invalid" });
    }
    const filenameBase = `financial-evidence-${report.range.localFrom}-${report.range.localToExclusive}-${report.reportFingerprint!.slice(0, 12)}`;
    if (format === "csv") {
      return new Response(`\uFEFF${renderFinancialReportCsv(report)}`, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filenameBase}.csv"`,
          "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow",
        },
      });
    }
    const pdf = await renderFinancialReportPdf(report);
    return new Response(Buffer.from(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filenameBase}.pdf"`,
        "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "financial_report_pdf_too_large" || message === "financial_report_too_large") {
      return noStore(413, { ok: false, error: "report_too_large" });
    }
    if (message.startsWith("financial_report_")) return noStore(409, { ok: false, error: "report_snapshot_invalid" });
    return noStore(503, { ok: false, error: "export_unavailable" });
  }
}
