import "server-only";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

import sharp from "sharp";

import { formatCurrency, isSupportedCurrency } from "@/shared/lib/currencyFormat";
import { financialCoverageMetricLabel, financialCoverageReasonLabel, financialCoverageStateLabel } from "./financialCoveragePresentation";
import type { FinancialReportDTO } from "./financialReportDto";

const interFilesDirectory = resolve(
  process.cwd(),
  "node_modules",
  "@fontsource",
  "inter",
  "files",
);
const PAGE_WIDTH = 1240;
const PAGE_HEIGHT = 1754;
const PDF_WIDTH = 595;
const PDF_HEIGHT = 842;
const LINES_PER_PAGE = 42;
const MAX_PDF_PAGES = 60;
const WRAP_COLUMNS = 92;

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
function pdfString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}
function money(value: number | null, currency: string): string {
  if (value === null) return "unavailable";
  if (!isSupportedCurrency(currency)) throw new Error("financial_report_currency_unsupported");
  const formatted = formatCurrency(Math.abs(value), currency);
  return `${value < 0 ? "-" : ""}${formatted ?? "unavailable"} (${value} smallest units)`;
}
function wrapLine(value: string): string[] {
  if (value.length <= WRAP_COLUMNS) return [value];
  const output: string[] = [];
  let remaining = value;
  while (remaining.length > WRAP_COLUMNS) {
    let split = remaining.lastIndexOf(" ", WRAP_COLUMNS);
    if (split < Math.floor(WRAP_COLUMNS / 2)) split = WRAP_COLUMNS;
    output.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trimStart();
  }
  output.push(remaining);
  return output;
}
function reportLines(report: FinancialReportDTO): string[] {
  const lines = [
    "Financial evidence report",
    `Salon: ${report.salon.name}`,
    `Salon timezone: ${report.salon.timezone}`,
    `Range: ${report.range.localFrom} to ${report.range.localToExclusive} (exclusive)` ,
    `UTC booking range: ${report.range.utcFrom} to ${report.range.utcToExclusive}`,
    `Evidence cutoff (exclusive): ${report.range.effectiveUtcToExclusive}`,
    `Data as of: ${report.dataAsOf}`,
    `Report fingerprint: ${report.reportFingerprint}`,
    `Source fingerprint: ${report.sourceFingerprint ?? "unavailable"}`,
    `Basis: ${report.basis}`,
    "Booking estimates and provider-collected operations are separate.",
    "",
    `Booked subtotal estimate: ${money(report.totals.bookedSubtotalCents, report.salon.currency)}`,
    `Booked tax estimate: ${money(report.totals.bookedTaxCents, report.salon.currency)}`,
    `Booked total estimate: ${money(report.totals.bookedTotalCents, report.salon.currency)}`,
    `Provider-collected gross: ${money(report.totals.collectedGrossCents, report.salon.currency)}`,
    `Receipt-backed refunds: ${money(report.totals.refundCents, report.salon.currency)}`,
    `Evidenced net movement: ${money(report.totals.collectedNetCents, report.salon.currency)}`,
    `Tips: ${money(report.totals.tipCents, report.salon.currency)}`,
    `Commission: ${money(report.totals.commissionCents, report.salon.currency)}`,
    "",
    "Coverage",
    ...Object.entries(report.coverage).sort(([a], [b]) => a.localeCompare(b)).map(
      ([metric, coverage]) => `${financialCoverageMetricLabel(metric as keyof typeof report.coverage, "en")}: ${financialCoverageStateLabel(coverage.state, "en")}; included ${coverage.includedRows}; excluded ${coverage.excludedRows}; sources ${JSON.stringify(coverage.sourceCounts)}; reasons ${coverage.reasonCodes.map((code) => financialCoverageReasonLabel(code, "en")).join(" | ") || "no gaps"}`,
    ),
    "",
    `Booking estimate rows (${report.bookingRows.length})`,
    ...report.bookingRows.map((row) =>
      `${row.occurredAt} | ${row.sourcePath} | booking ${row.bookingId ?? "unavailable"} | subtotal ${row.bookedSubtotalCents ?? "?"} | tax ${row.bookedTaxCents ?? "?"} | total ${row.bookedTotalCents ?? "?"}`),
    "",
    `Financial operation events (${report.operationEvents.length})`,
    ...report.operationEvents.map((event) =>
      `${event.occurredAt} | ${event.kind} | ${event.status} | operation ${event.operationId} | gross ${event.evidencedGrossCents ?? "?"} | refund ${event.evidencedRefundCents ?? "?"} | net ${event.evidencedNetCents ?? "?"}`),
    "",
    `Metric evidence events (${report.metricEvents.length}); policies (${report.metricPolicies.length})`,
    ...report.metricEvents.map((event) =>
      `${event.occurredAt} | ${event.metric} | ${event.effect} | ${event.signedAmountCents} ${event.currency} minor units | evidence ${event.evidenceId}`),
  ];
  return lines.flatMap(wrapLine);
}

async function fontCss(): Promise<string> {
  const [latin, latinExt, vietnamese] = await Promise.all([
    readFile(resolve(interFilesDirectory, "inter-latin-400-normal.woff2")),
    readFile(resolve(interFilesDirectory, "inter-latin-ext-400-normal.woff2")),
    readFile(resolve(interFilesDirectory, "inter-vietnamese-400-normal.woff2")),
  ]);
  const face = (bytes: Buffer, range: string) => `@font-face{font-family:Inter;src:url(data:font/woff2;base64,${bytes.toString("base64")}) format('woff2');font-weight:400;unicode-range:${range};}`;
  return [
    face(vietnamese, "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB"),
    face(latinExt, "U+0100-02FF,U+1E00-1EFF,U+20A0-20CF"),
    face(latin, "U+0000-00FF,U+2000-206F,U+20AC"),
  ].join("");
}

function svgPage(lines: string[], page: number, pages: number, css: string): Buffer {
  const text = lines.map((line, index) => {
    const y = 145 + index * 34;
    const size = index === 0 && page === 1 ? 34 : 22;
    const weight = index === 0 && page === 1 ? 700 : 400;
    return `<text x="84" y="${y}" font-size="${size}" font-weight="${weight}" fill="#172033">${xml(line || " ")}</text>`;
  }).join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}"><style>${css}text{font-family:Inter,sans-serif}</style><rect width="100%" height="100%" fill="#fff"/><rect x="0" y="0" width="18" height="100%" fill="#9f7aea"/><text x="84" y="70" font-family="Inter" font-size="18" fill="#6b7280">NailIQ · authoritative evidence · page ${page}/${pages}</text>${text}</svg>`, "utf8");
}

function streamObject(dictionary: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`<< ${dictionary} /Length ${data.length} >>\nstream\n`, "ascii"), data, Buffer.from("\nendstream", "ascii")]);
}

function assemblePdf(objects: Buffer[]): Buffer {
  const parts = [Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const offsets = [0];
  let offset = parts[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(offset);
    const wrapped = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, "ascii"), object, Buffer.from("\nendobj\n", "ascii")]);
    parts.push(wrapped); offset += wrapped.length;
  });
  const xrefOffset = offset;
  const xref = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n", ...offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(Buffer.from(xref, "ascii"));
  parts.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, "ascii"));
  return Buffer.concat(parts);
}

/** Server-runtime PDF renderer; no provider, browser, Python, or remote font call. */
export async function renderFinancialReportPdf(report: FinancialReportDTO): Promise<Uint8Array> {
  if (!report.reportFingerprint || !/^[0-9a-f]{64}$/.test(report.reportFingerprint)) throw new Error("financial_report_fingerprint_missing");
  const chunks: string[][] = [];
  const lines = reportLines(report);
  for (let index = 0; index < lines.length; index += LINES_PER_PAGE) chunks.push(lines.slice(index, index + LINES_PER_PAGE));
  if (chunks.length === 0) chunks.push([]);
  if (chunks.length > MAX_PDF_PAGES) throw new Error("financial_report_pdf_too_large");
  const css = await fontCss();
  const pageImages: Array<{ data: Buffer; width: number; height: number }> = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    const rendered = await sharp(svgPage(chunk, index + 1, chunks.length, css)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    pageImages.push({ data: deflateSync(rendered.data, { level: 9 }), width: rendered.info.width, height: rendered.info.height });
  }

  const objects: Buffer[] = [];
  objects.push(Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii"));
  const pageObjectNumbers = pageImages.map((_, index) => 4 + index * 3);
  objects.push(Buffer.from(`<< /Type /Pages /Count ${pageImages.length} /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] >>`, "ascii"));
  objects.push(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "ascii"));
  pageImages.forEach((image, index) => {
    const pageNumber = 4 + index * 3;
    const imageNumber = pageNumber + 1;
    const contentNumber = pageNumber + 2;
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_WIDTH} ${PDF_HEIGHT}] /Resources << /Font << /F1 3 0 R >> /XObject << /Im${index + 1} ${imageNumber} 0 R >> >> /Contents ${contentNumber} 0 R >>`, "ascii"));
    objects.push(streamObject(`/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, image.data));
    const hidden = [
      "NailIQ Financial Evidence Report",
      `Report fingerprint: ${report.reportFingerprint}`,
      `Booked total cents: ${report.totals.bookedTotalCents ?? "unavailable"}`,
      `Collected gross cents: ${report.totals.collectedGrossCents ?? "unavailable"}`,
      `Refund cents: ${report.totals.refundCents ?? "unavailable"}`,
      `Page ${index + 1} of ${pageImages.length}`,
    ].map((line, lineIndex) => `BT /F1 8 Tf 3 Tr 20 ${20 + lineIndex * 9} Td (${pdfString(line)}) Tj ET`).join("\n");
    const content = Buffer.from(`q ${PDF_WIDTH} 0 0 ${PDF_HEIGHT} 0 0 cm /Im${index + 1} Do Q\n${hidden}`, "ascii");
    objects.push(streamObject("", content));
  });
  return assemblePdf(objects);
}
