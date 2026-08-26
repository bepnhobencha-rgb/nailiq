import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  canonicalFinancialJson,
  financialReportFingerprintMaterial,
  type FinancialReportDTO,
} from "./financialReportDto";

const MAX_EXPORT_AGE_MS = 15 * 60 * 1000;

function secret(): string {
  const value =
    process.env.FINANCIAL_REPORT_EXPORT_SECRET?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!value) throw new Error("financial_report_export_signing_unavailable");
  return value;
}

function material(report: FinancialReportDTO, actorUserId: string, expiresAtMs: number): string {
  return canonicalFinancialJson({
    v: 1,
    actorUserId,
    expiresAtMs,
    report,
  });
}

function hasExactFingerprint(report: FinancialReportDTO): boolean {
  if (!report.reportFingerprint || !/^[0-9a-f]{64}$/.test(report.reportFingerprint)) return false;
  const expected = createHash("sha256")
    .update(financialReportFingerprintMaterial(report), "utf8")
    .digest();
  const actual = Buffer.from(report.reportFingerprint, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Signs the exact PII-minimized DTO shown in UI for a short export window. */
export function signFinancialReportSnapshot(
  report: FinancialReportDTO,
  actorUserId: string,
  nowMs = Date.now(),
): string {
  if (!hasExactFingerprint(report)) {
    throw new Error("financial_report_fingerprint_missing");
  }
  const expiresAtMs = nowMs + MAX_EXPORT_AGE_MS;
  const mac = createHmac("sha256", secret())
    .update(material(report, actorUserId, expiresAtMs), "utf8")
    .digest("base64url");
  return `v1.${expiresAtMs}.${mac}`;
}

export function verifyFinancialReportSnapshot(
  report: FinancialReportDTO,
  actorUserId: string,
  token: string,
  nowMs = Date.now(),
): boolean {
  if (!hasExactFingerprint(report)) return false;
  const [version, rawExpiry, providedMac, extra] = token.split(".");
  if (version !== "v1" || !rawExpiry || !providedMac || extra !== undefined) return false;
  const expiresAtMs = Number(rawExpiry);
  if (
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs < nowMs ||
    expiresAtMs > nowMs + MAX_EXPORT_AGE_MS
  ) return false;
  try {
    const expectedMac = createHmac("sha256", secret())
      .update(material(report, actorUserId, expiresAtMs), "utf8")
      .digest("base64url");
    const actual = Buffer.from(providedMac, "utf8");
    const expected = Buffer.from(expectedMac, "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
