import "server-only";
import { createHmac } from "node:crypto";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * CASL / CAN-SPAM email compliance helpers, shared by every customer email:
 *  - a tamper-proof (HMAC-signed) one-click unsubscribe link,
 *  - the List-Unsubscribe / one-click headers Gmail+Apple honour,
 *  - a footer block carrying the sender ID + physical mailing address + the
 *    unsubscribe link (all three are CASL requirements for a commercial email),
 *  - a suppression check so opted-out addresses are skipped.
 */

function origin(): string {
  const base =
    (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  return (base || "https://nailiq.ca").replace(/\/$/, "");
}

function signingKey(): string {
  return (process.env.INTERNAL_API_SECRET ?? "").trim() || "nailiq-fallback-key";
}

/** HMAC of the lowercased email — short, URL-safe, not reversible. */
export function unsubscribeSig(email: string): string {
  return createHmac("sha256", signingKey())
    .update(email.trim().toLowerCase())
    .digest("base64url")
    .slice(0, 24);
}

export function unsubscribeValid(email: string, sig: string): boolean {
  if (!email || !sig) return false;
  // Constant-ish compare (length + value) — sigs are short fixed-length.
  return sig === unsubscribeSig(email);
}

/** Public one-click unsubscribe URL for an email address. */
export function unsubscribeUrl(email: string): string {
  const e = encodeURIComponent(email.trim().toLowerCase());
  return `${origin()}/unsubscribe?e=${e}&sig=${unsubscribeSig(email)}`;
}

/** RFC 8058 one-click endpoint (POST target) for the List-Unsubscribe header. */
export function unsubscribePostUrl(email: string): string {
  const e = encodeURIComponent(email.trim().toLowerCase());
  return `${origin()}/api/unsubscribe?e=${e}&sig=${unsubscribeSig(email)}`;
}

/** Headers that make Gmail/Apple show a native "Unsubscribe" button + support
 *  RFC 8058 one-click. Pass into resend.emails.send({ headers }). */
export function listUnsubscribeHeaders(email: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${unsubscribePostUrl(email)}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/** Shared HTML footer: sender identity + physical mailing address + unsubscribe
 *  link. Append inside every customer email's body. */
export function complianceFooterHtml(opts: {
  email: string;
  salonName: string;
  salonAddress?: string | null;
  lang?: "en" | "vi";
}): string {
  const vi = opts.lang === "vi";
  const url = unsubscribeUrl(opts.email);
  const addr = (opts.salonAddress ?? "").trim();
  const why = vi
    ? `Bạn nhận email này vì có lịch hẹn với <strong>${esc(opts.salonName)}</strong>.`
    : `You're receiving this because you have an appointment with <strong>${esc(opts.salonName)}</strong>.`;
  const addrLine = addr
    ? `<div style="margin:4px 0;">${esc(opts.salonName)} · ${esc(addr)}</div>`
    : `<div style="margin:4px 0;">${esc(opts.salonName)}</div>`;
  const unsub = vi
    ? `<a href="${url}" style="color:#888;text-decoration:underline;">Ngừng nhận email</a>`
    : `<a href="${url}" style="color:#888;text-decoration:underline;">Unsubscribe</a>`;
  return `<div style="margin:18px 0 0;padding-top:12px;border-top:1px solid #eee;font-size:11px;line-height:1.5;color:#999;text-align:center;">
    <div>${why}</div>
    ${addrLine}
    <div style="margin-top:4px;">${unsub}</div>
  </div>`;
}

/** True when this email has opted out of optional/marketing mail. Transactional
 *  booking confirmations should NOT gate on this. Fails OPEN (false) on error so
 *  a DB hiccup never silently drops mail. */
export async function isEmailSuppressed(email: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  if (!e) return false;
  try {
    const { data } = await createServiceRoleClient()
      .from("client_email_optouts" as never)
      .select("email")
      .eq("email", e)
      .maybeSingle();
    return Boolean(data);
  } catch {
    return false;
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
