/** Temporary QA-only, read-only gate. Remove before any Production merge. */
import { timingSafeEqual } from "node:crypto";

import { getResendFrom } from "@/shared/lib/resend";
import { resolveResendQaBoundary } from "@/shared/notifications/resendQaBoundary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QA_REF = "uhpzafoiifupyypkcwln";
const QA_URL = `https://${QA_REF}.supabase.co`;
const QA_BRANCH = "audit/p0-03-tenant-runtime-20260921";
const RECIPIENT = "t.huy2606@icloud.com";
const EXPIRES_AT = Date.parse("2026-09-25T00:00:00Z");

function authorized(request: Request): boolean {
  const expected = process.env.NAILIQ_QA_ONE_EMAIL_TOKEN ?? "";
  const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

function configurationChecks(): Record<string, boolean> {
  const env = process.env;
  return {
    preview: env.VERCEL_ENV === "preview",
    qaBranch: env.VERCEL_GIT_COMMIT_REF === QA_BRANCH,
    disposable: env.NAILIQ_DISPOSABLE_DB === "1",
    qaPin: env.NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF === QA_REF,
    publicQaUrl: env.NEXT_PUBLIC_SUPABASE_URL === QA_URL,
    serverQaUrl: env.SUPABASE_INTERNAL_URL === QA_URL,
    qaMode: env.NAILIQ_RESEND_QA_WEBHOOK_ONLY === "1" &&
      resolveResendQaBoundary(env).mode === "qa",
    recipientPin: env.NAILIQ_QA_RESEND_EMAIL_RECIPIENT === RECIPIENT,
    smsOff: env.DISABLE_OUTBOUND_SMS === "1",
    callsOff: env.DISABLE_OUTBOUND_CALLS === "1",
    emailOff: env.DISABLE_OUTBOUND_EMAIL === "1",
    ledgerOff: env.PAYMENT_LEDGER_WORKERS_ENABLED === "false",
    noShowChargeOff: env.NAILIQ_APPROVED_NO_SHOW_CHARGE_DISPATCH === "false",
    cancellationChargeOff: env.NAILIQ_APPROVED_CANCELLATION_FEE_DISPATCH === "false",
    cardSaveOff: env.NAILIQ_CARD_SAVE_DISPATCH_DISABLED === "true",
    squareIngestionOff: env.NAILIQ_SQUARE_PAYMENT_WEBHOOK_INGESTION === "false",
    providerKeyPresent: !!env.RESEND_API_KEY?.trim(),
    qaServiceKeyPresent: !!env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
    senderDomain: /@nailiq\.ca>?$/i.test(getResendFrom()),
  };
}

async function qaServiceKeyWorks(): Promise<boolean> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) return false;
  try {
    const response = await fetch(`${QA_URL}/rest/v1/salons?select=id&limit=1`, {
      method: "GET",
      headers: { apikey: key, authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return false;
    const rows: unknown = await response.json();
    return Array.isArray(rows);
  } catch {
    return false;
  }
}

/** Read-only, secret-protected QA gate. No credentials or PII are returned. */
export async function GET(request: Request): Promise<Response> {
  if (!authorized(request) || Date.now() >= EXPIRES_AT) {
    return Response.json({ ok: false }, { status: 404 });
  }
  const checks = configurationChecks();
  const qaKeyValid = checks.preview && checks.qaBranch && checks.disposable &&
    checks.qaPin && checks.publicQaUrl && checks.serverQaUrl &&
    checks.qaServiceKeyPresent && await qaServiceKeyWorks();
  const result = { ...checks, qaKeyValid };
  return Response.json(
    { ok: Object.values(result).every(Boolean), checks: result },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
}
