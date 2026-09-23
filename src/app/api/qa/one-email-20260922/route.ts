/**
 * Temporary, branch-pinned QA probe. Never promote this route to Production.
 * The provider idempotency key and removal of this deployment bound this test
 * to the single email explicitly authorized by the owner.
 */
import { timingSafeEqual } from "node:crypto";

import { emailExperienceTags } from "@/shared/lib/emailExperienceRegistry";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import {
  resendQaTagsForRecipient,
  resolveResendQaBoundary,
} from "@/shared/notifications/resendQaBoundary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QA_REF = "uhpzafoiifupyypkcwln";
const QA_URL = `https://${QA_REF}.supabase.co`;
const QA_BRANCH = "audit/p0-03-tenant-runtime-20260921";
const RECIPIENT = "t.huy2606@icloud.com";
const IDEMPOTENCY_KEY = "nailiq-p1-01-qa-20260922-uhpzafoiifupyypkcwln-v1";
const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function authorized(request: Request): boolean {
  const expected = process.env.NAILIQ_QA_ONE_EMAIL_TOKEN ?? "";
  const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

function configurationReady(): boolean {
  const env = process.env;
  return env.VERCEL_ENV === "preview" &&
    env.VERCEL_GIT_COMMIT_REF === QA_BRANCH &&
    env.NAILIQ_DISPOSABLE_DB === "1" &&
    env.NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF === QA_REF &&
    env.NEXT_PUBLIC_SUPABASE_URL === QA_URL &&
    env.SUPABASE_INTERNAL_URL === QA_URL &&
    env.NAILIQ_RESEND_QA_WEBHOOK_ONLY === "1" &&
    env.NAILIQ_QA_RESEND_EMAIL_RECIPIENT === RECIPIENT &&
    env.DISABLE_OUTBOUND_SMS === "1" &&
    env.DISABLE_OUTBOUND_CALLS === "1" &&
    env.DISABLE_OUTBOUND_EMAIL === "1" &&
    env.PAYMENT_LEDGER_WORKERS_ENABLED === "false" &&
    env.NAILIQ_APPROVED_NO_SHOW_CHARGE_DISPATCH === "false" &&
    env.NAILIQ_APPROVED_CANCELLATION_FEE_DISPATCH === "false" &&
    env.NAILIQ_CARD_SAVE_DISPATCH_DISABLED === "true" &&
    env.NAILIQ_SQUARE_PAYMENT_WEBHOOK_INGESTION === "false" &&
    !!env.RESEND_API_KEY?.trim() &&
    !!env.SUPABASE_SERVICE_ROLE_KEY?.trim() &&
    /@nailiq\.ca>?$/i.test(getResendFrom()) &&
    resolveResendQaBoundary(env).mode === "qa";
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

async function ready(): Promise<boolean> {
  return configurationReady() && await qaServiceKeyWorks();
}

/** Read-only, secret-protected QA gate. No configuration values are returned. */
export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) return json({ ok: false }, 404);
  return json({ ok: await ready() });
}

/** Exactly one fixed recipient and payload; no request body is used. */
export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return json({ ok: false }, 404);
  if (!await ready()) return json({ ok: false, code: "qa_boundary_not_ready" }, 503);

  const qaTags = resendQaTagsForRecipient(RECIPIENT, resolveResendQaBoundary());
  if (!qaTags || qaTags.length !== 2) return json({ ok: false, code: "qa_tags_invalid" }, 503);

  const resend = getResendClient();
  if (!resend) return json({ ok: false, code: "provider_not_configured" }, 503);

  try {
    const { data, error } = await resend.emails.send({
      from: getResendFrom(),
      to: RECIPIENT,
      subject: "NailIQ QA — one-email delivery check",
      text: "This is the one authorized NailIQ QA email. No booking or salon data was used.",
      html: "<p>This is the one authorized NailIQ QA email. No booking or salon data was used.</p>",
      tags: [...emailExperienceTags("provider_connection_test"), ...qaTags],
    }, { idempotencyKey: IDEMPOTENCY_KEY });
    if (error || !data?.id) return json({ ok: false, code: "provider_rejected" }, 502);
    return json({ ok: true, providerMessageId: data.id });
  } catch {
    return json({ ok: false, code: "provider_uncertain" }, 502);
  }
}
