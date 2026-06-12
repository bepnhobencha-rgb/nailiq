import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { formatCurrency } from "@/shared/lib/currencyFormat";
import { generateReminderToken } from "@/shared/noshow/generateReminderToken";

/** Grace period after the appointment start during which the self-serve
 *  reschedule/cancel link stays valid. */
const SELF_SERVE_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * Send a booking confirmation email to the customer.
 *
 * Best-effort: failures are logged but never propagate to the caller.
 * The booking row is already committed before this fires — email loss
 * is better than a failed booking that the customer re-submits.
 *
 * Called from `submitPublicBooking` after the RPC insert succeeds.
 */

type BookingConfirmationInput = {
  bookingId: string;
  shopSlug: string;
  clientName: string;
  clientEmail: string;
  serviceName: string;
  addonServiceName?: string | null;
  staffName: string;
  startTimeUtc: string;
  /** Price in cents (main + addon). Null means price not set. */
  totalPriceCents: number | null;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateTimeForEmail(
  utcIso: string,
  timezone: string,
): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(utcIso));
  } catch {
    return utcIso;
  }
}

function getEmailOrigin(): string {
  const base =
    (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  const origin = base.length > 0 ? base : "https://nailiq.ca";
  return origin.replace(/\/$/, "");
}

function buildConfirmationUrl(shopSlug: string, bookingId: string): string {
  return `${getEmailOrigin()}/${shopSlug}/wait/${bookingId}`;
}

/** Self-serve reschedule/cancel links built from a reminder token. */
export type ManageLinks = { reschedule: string; cancel: string };

/** Exported for unit tests — pure render, no I/O. */
export function buildHtml(
  salonName: string,
  input: BookingConfirmationInput,
  dateTimeStr: string,
  confirmUrl: string,
  currencyCode: string,
  manageLinks: ManageLinks | null,
  address?: string | null,
  salonPhone?: string | null,
): string {
  const eName = escapeHtml(input.clientName);
  const eSalon = escapeHtml(salonName);
  const eService = escapeHtml(input.serviceName);
  const eAddon = input.addonServiceName ? escapeHtml(input.addonServiceName) : null;
  const eStaff = escapeHtml(input.staffName);
  const eDateTime = escapeHtml(dateTimeStr);

  // Location: render the address + a "Get directions" button (Google Maps URL
  // built from the address — no extra DB column needed) so the customer,
  // especially a first-timer, can find the salon. Phone (if set) becomes a
  // tap-to-call link in the contact line.
  const addr = address?.trim() || "";
  const eAddress = addr ? escapeHtml(addr) : null;
  const mapsUrl = addr
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`
    : null;
  const phone = salonPhone?.trim() || "";
  const ePhone = phone ? escapeHtml(phone) : null;
  const telHref = phone ? phone.replace(/[^\d+]/g, "") : null;
  const locationBlock = eAddress
    ? `<div style="margin:18px 0 0;padding:16px;border:1px solid #eee;border-radius:8px;background:#fafafa;">
              <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#888;">Location</p>
              <p style="margin:0 0 12px;font-size:14px;color:#333;line-height:1.45;">${eAddress}</p>
              <a href="${mapsUrl}" style="display:inline-block;padding:9px 18px;background:#0B0C10;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:13px;">📍 Get directions</a>
            </div>`
    : "";

  const priceStr =
    input.totalPriceCents != null && input.totalPriceCents > 0
      ? (formatCurrency(input.totalPriceCents, currencyCode) ?? null)
      : null;

  const addonRow = eAddon
    ? `<tr>
        <td style="padding:6px 0;color:#666;font-size:14px;width:120px;">Add-on</td>
        <td style="padding:6px 0;font-size:14px;">${eAddon}</td>
       </tr>`
    : "";

  const priceRow = priceStr
    ? `<tr>
        <td style="padding:6px 0;color:#666;font-size:14px;width:120px;">Total</td>
        <td style="padding:6px 0;font-size:14px;font-weight:600;">${escapeHtml(priceStr)}</td>
       </tr>`
    : "";

  return `<!doctype html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.07);">

        <!-- Header -->
        <tr>
          <td style="background:#0B0C10;padding:24px 32px;text-align:center;">
            <span style="font-size:20px;font-weight:700;color:#D4AF37;letter-spacing:0.04em;">NailIQ</span>
            <p style="margin:6px 0 0;font-size:12px;color:#999;letter-spacing:0.08em;text-transform:uppercase;">Booking Confirmed</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:28px 32px;">
            <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;">You're all set, ${eName}! ✓</h1>
            <p style="margin:0 0 24px;color:#555;font-size:15px;">Your appointment at <strong>${eSalon}</strong> has been confirmed.</p>

            <!-- Booking details -->
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:8px;overflow:hidden;">
              <tr>
                <td colspan="2" style="background:#fafafa;padding:12px 16px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#888;border-bottom:1px solid #eee;">
                  Appointment Details
                </td>
              </tr>
              <tr><td style="padding:0 16px 0;"><table width="100%" cellpadding="0" cellspacing="0" style="padding:12px 0;">
                <tr>
                  <td style="padding:6px 0;color:#666;font-size:14px;width:120px;">Date &amp; Time</td>
                  <td style="padding:6px 0;font-size:14px;font-weight:600;">${eDateTime}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#666;font-size:14px;">Service</td>
                  <td style="padding:6px 0;font-size:14px;">${eService}</td>
                </tr>
                ${addonRow}
                <tr>
                  <td style="padding:6px 0;color:#666;font-size:14px;">Staff</td>
                  <td style="padding:6px 0;font-size:14px;">${eStaff}</td>
                </tr>
                ${priceRow}
              </table></td></tr>
            </table>

            <!-- Location + directions -->
            ${locationBlock}

            <!-- CTA -->
            <div style="margin:24px 0 0;text-align:center;">
              <a href="${confirmUrl}" style="display:inline-block;padding:12px 28px;background:#D4AF37;color:#0B0C10;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;">
                View Booking Status
              </a>
            </div>

            ${
              manageLinks
                ? `<p style="margin:20px 0 0;font-size:13px;color:#888;text-align:center;">
              Need to make a change?
              <a href="${manageLinks.reschedule}" style="color:#0B0C10;font-weight:600;text-decoration:underline;">Reschedule</a>
              &nbsp;·&nbsp;
              <a href="${manageLinks.cancel}" style="color:#0B0C10;font-weight:600;text-decoration:underline;">Cancel</a>
            </p>`
                : `<p style="margin:20px 0 0;font-size:13px;color:#888;text-align:center;">
              Need to reschedule? Contact <strong>${eSalon}</strong>${ePhone && telHref ? ` at <a href="tel:${telHref}" style="color:#0B0C10;font-weight:600;text-decoration:underline;">${ePhone}</a>` : ""} directly.
            </p>`
            }
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#fafafa;border-top:1px solid #eee;padding:16px 32px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#aaa;">
              Powered by <a href="https://nailiq.ca" style="color:#aaa;">NailIQ</a> — AI Booking System for Nail Salons
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendBookingConfirmationEmail(
  input: BookingConfirmationInput,
): Promise<void> {
  if (!input.clientEmail || input.clientEmail.trim().length === 0) return;

  const resend = getResendClient();
  if (!resend) {
    console.warn("[sendBookingConfirmationEmail] no RESEND_API_KEY — skipping");
    return;
  }

  console.log("[sendBookingConfirmationEmail] sending to", input.clientEmail, "booking", input.bookingId);

  try {
    const supabase = createServiceRoleClient();
    const { data: salonRow } = await supabase
      .from("salons")
      .select("id, name, timezone, currency, reminders_enabled, address, salon_phone")
      .eq("slug", input.shopSlug)
      .maybeSingle();

    const salonName = (salonRow?.name as string | null | undefined)?.trim() || input.shopSlug;
    const timezone =
      typeof salonRow?.timezone === "string" && salonRow.timezone.trim()
        ? salonRow.timezone.trim()
        : "America/Vancouver";
    const currencyCode =
      typeof salonRow?.currency === "string" && salonRow.currency.trim()
        ? salonRow.currency.trim()
        : "CAD";

    const dateTimeStr = formatDateTimeForEmail(input.startTimeUtc, timezone);
    const confirmUrl = buildConfirmationUrl(input.shopSlug, input.bookingId);

    // Self-serve reschedule/cancel links — gated on the salon's existing
    // customer self-service opt-in (`reminders_enabled`, the same switch that
    // already puts these links in reminder emails). Token expires a short grace
    // after the appointment so the link works right up to the visit, not 48h
    // after booking. Best-effort: if the token can't be minted we fall back to
    // the "contact the salon" copy.
    let manageLinks: ManageLinks | null = null;
    const salonId =
      typeof salonRow?.id === "string" ? salonRow.id : null;
    if (salonId && salonRow?.reminders_enabled === true) {
      const startMs = Date.parse(input.startTimeUtc);
      const expiresAt = Number.isFinite(startMs)
        ? new Date(startMs + SELF_SERVE_GRACE_MS).toISOString()
        : undefined;
      const token = await generateReminderToken(input.bookingId, salonId, { expiresAt });
      if (token) {
        const origin = getEmailOrigin();
        manageLinks = {
          reschedule: `${origin}/booking/reschedule?token=${token.id}`,
          cancel: `${origin}/booking/cancel?token=${token.id}`,
        };
      }
    }

    const address =
      typeof salonRow?.address === "string" ? salonRow.address : null;
    const salonPhone =
      typeof salonRow?.salon_phone === "string" ? salonRow.salon_phone : null;

    const html = buildHtml(
      salonName,
      input,
      dateTimeStr,
      confirmUrl,
      currencyCode,
      manageLinks,
      address,
      salonPhone,
    );

    const res = await resend.emails.send({
      from: getResendFrom(),
      to: input.clientEmail.trim(),
      subject: `Booking confirmed — ${salonName}`,
      html,
    });

    if (res.error) {
      console.error("[sendBookingConfirmationEmail] resend error", res.error);
    } else {
      console.log("[sendBookingConfirmationEmail] sent ok id=", res.data?.id);
    }
  } catch (e) {
    console.error("[sendBookingConfirmationEmail] threw", e);
  }
}
