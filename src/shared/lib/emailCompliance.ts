import "server-only";
import { createHash, createHmac } from "node:crypto";
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
  /** Transactional appointment notices still send after optional-email opt-out. */
  transactional?: boolean;
  /** Why this recipient is receiving the message; keeps non-booking mail honest. */
  context?: "appointment" | "waitlist" | "marketing" | "security";
}): string {
  const vi = opts.lang === "vi";
  const url = unsubscribeUrl(opts.email);
  const addr = (opts.salonAddress ?? "").trim();
  const why = opts.context === "waitlist"
    ? vi
      ? `Bạn nhận email này vì đã yêu cầu <strong>${esc(opts.salonName)}</strong> báo khi có chỗ trống.`
      : `You're receiving this because you asked <strong>${esc(opts.salonName)}</strong> to notify you when a time opens.`
    : opts.context === "marketing"
      ? vi
        ? `Bạn nhận cập nhật không bắt buộc từ <strong>${esc(opts.salonName)}</strong>.`
        : `You're receiving an optional update from <strong>${esc(opts.salonName)}</strong>.`
      : opts.context === "security"
        ? vi
          ? `Bạn đã yêu cầu bước xác minh an toàn cho <strong>${esc(opts.salonName)}</strong>.`
          : `You requested a secure verification step for <strong>${esc(opts.salonName)}</strong>.`
        : opts.transactional
    ? vi
      ? `Đây là thông báo quan trọng về lịch hẹn của bạn với <strong>${esc(opts.salonName)}</strong>.`
      : `This is an important appointment update from <strong>${esc(opts.salonName)}</strong>.`
    : vi
      ? `Bạn nhận email này vì có lịch hẹn với <strong>${esc(opts.salonName)}</strong>.`
      : `You're receiving this because you have an appointment with <strong>${esc(opts.salonName)}</strong>.`;
  const addrLine = addr
    ? `<div style="margin:4px 0;">${esc(opts.salonName)} · ${esc(addr)}</div>`
    : `<div style="margin:4px 0;">${esc(opts.salonName)}</div>`;
  const unsub = opts.transactional
    ? vi
      ? `<a href="${url}" style="color:#888;text-decoration:underline;">Quản lý email không bắt buộc</a><div>${opts.context === "security" ? "Email bảo mật bạn yêu cầu vẫn có thể được gửi." : "Thông báo quan trọng về lịch hẹn vẫn có thể được gửi."}</div>`
      : `<a href="${url}" style="color:#888;text-decoration:underline;">Manage optional emails</a><div>${opts.context === "security" ? "Security emails you request may still be sent." : "Important appointment updates may still be sent."}</div>`
    : vi
      ? `<a href="${url}" style="color:#888;text-decoration:underline;">Ngừng nhận email</a>`
      : `<a href="${url}" style="color:#888;text-decoration:underline;">Unsubscribe</a>`;
  return `<div style="margin:18px 0 0;padding-top:12px;border-top:1px solid #eee;font-size:11px;line-height:1.5;color:#999;text-align:center;">
    <div>${why}</div>
    ${addrLine}
    <div style="margin-top:4px;">${unsub}</div>
  </div>`;
}

/** True when this email has opted out of optional/marketing mail. Transactional
 *  booking confirmations should NOT gate on this. Fails CLOSED (true) when the
 *  suppression list cannot be read so optional mail is never sent while consent
 *  state is unknown. */
export async function isEmailSuppressed(email: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  if (!e) return false;
  try {
    const { data, error } = await createServiceRoleClient()
      .from("client_email_optouts" as never)
      .select("email")
      .eq("email", e)
      .maybeSingle();
    if (error) return true;
    return Boolean(data);
  } catch {
    return true;
  }
}

/**
 * Provider-level suppression for transactional booking mail. Marketing opt-out
 * is intentionally excluded: a customer who declined promotions must still
 * receive booking cancellations and reschedules. Throws when delivery truth
 * cannot be read so workers can retry before provider acceptance.
 */
export async function transactionalEmailSuppressionReason(
  salonId: string,
  email: string,
): Promise<"suppressed" | "bounced" | "complained" | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const fingerprint = createHash("sha256")
    .update(normalized, "utf8")
    .digest("hex");
  const { data, error } = await createServiceRoleClient().rpc(
    "customer_email_delivery_suppression_reason" as never,
    {
      p_salon_id: salonId,
      p_recipient_fingerprint: fingerprint,
    } as never,
  );
  if (error) throw error;
  return data === "suppressed" || data === "bounced" || data === "complained"
    ? data
    : null;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
