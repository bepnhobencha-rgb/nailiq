import { getResendFrom } from "@/shared/lib/resend";
import { complianceFooterHtml, listUnsubscribeHeaders } from "@/shared/lib/emailCompliance";
import { googleCalendarUrl, buildIcs } from "@/shared/lib/calendarLinks";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { formatCurrency } from "@/shared/lib/currencyFormat";
import { generateReminderToken } from "@/shared/noshow/generateReminderToken";
import {
  buildEmailBrandHeader,
  normalizeEmailLocale,
  normalizeEmailLogoUrl,
  type EmailLocale,
} from "@/shared/booking/emailBranding";
import type { BookingSequenceReceipt } from "@/shared/booking/bookingSequenceReceipt";
import { loadBookingSequenceReceipt } from "@/shared/booking/bookingSequenceReceiptServer";
import { deliverBookingConfirmation } from "@/shared/booking/bookingConfirmationRetryDelivery";

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
  clientLocale?: EmailLocale | null;
  serviceName: string;
  addonServiceName?: string | null;
  staffName: string;
  startTimeUtc: string;
  /** Price in cents (main + addon), null means price not set. */
  totalPriceCents: number | null;
  /** Pre-tax subtotal (when tax applies). Null when no tax or no price. */
  subtotalCents?: number | null;
  /** Itemized tax breakdown for receipt display. */
  taxBreakdown?: { name: string; rate: number; amountCents: number }[];
  currencyCode?: string;
  servicePriceCents?: number | null;
  addonLines?: { name: string; priceCents: number }[];
  discountLines?: { label: string; amountCents: number }[];
  /** Persisted multi-service receipt. Never accept this field from a browser. */
  sequenceReceipt?: BookingSequenceReceipt | null;
  sequenceLineDateTimes?: string[];
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
  locale: EmailLocale,
): string {
  try {
    return new Intl.DateTimeFormat(locale === "vi" ? "vi-VN" : "en-US", {
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

function buildConfirmationUrl(shopSlug: string, statusToken?: string | null): string {
  return statusToken
    ? `${getEmailOrigin()}/booking/status?token=${encodeURIComponent(statusToken)}`
    : `${getEmailOrigin()}/${encodeURIComponent(shopSlug)}`;
}

export function buildBookingConfirmationSubject(
  salonName: string,
  locale: EmailLocale | null | undefined,
): string {
  return normalizeEmailLocale(locale) === "vi"
    ? `Lịch hẹn đã xác nhận — ${salonName}`
    : `Booking confirmed — ${salonName}`;
}

/** Self-serve reschedule/cancel links built from a reminder token. */
export type ManageLinks = { reschedule: string; cancel: string };

/** Saved no-show card disclosure for the email (display fields only). */
export type SavedCardInfo = { brand: string; last4: string; feeLabel: string; manageUrl: string };

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
  savedCard?: SavedCardInfo | null,
  calendarUrl?: string | null,
  policyUrl?: string | null,
  bookAgainUrl?: string | null,
  salonLogoUrl?: string | null,
): string {
  const locale = normalizeEmailLocale(input.clientLocale);
  const copy = locale === "vi"
    ? {
        subtitle: "Lịch hẹn đã xác nhận", location: "Địa điểm", directions: "📍 Chỉ đường",
        addon: "Dịch vụ thêm", subtotal: "Tạm tính", totalWithTax: "Tổng cộng (đã gồm thuế)", total: "Tổng cộng",
        cardOnFile: "Thẻ đã lưu", cardDisclosure: "Để giữ chỗ, chúng tôi đã lưu an toàn thẻ",
        cardUse: "Thẻ chỉ bị tính phí", cardCondition: "nếu bạn không đến — ngoài trường hợp đó sẽ không tính phí.",
        manageCard: "Quản lý hoặc xoá thẻ", allSet: "Lịch hẹn đã sẵn sàng",
        confirmedAt: "Lịch hẹn của bạn tại", confirmedSuffix: "đã được xác nhận.", details: "Chi tiết lịch hẹn",
        dateTime: "Ngày & giờ", service: "Dịch vụ", staff: "Nhân viên", viewStatus: "Xem trạng thái lịch hẹn",
        addCalendar: "📅 Thêm vào lịch", calendarHint: "Apple Mail · Outlook: mở tệp lịch đính kèm",
        needChange: "Cần thay đổi?", reschedule: "Dời lịch", cancel: "Huỷ lịch",
        contactPrefix: "Cần dời lịch? Liên hệ trực tiếp", policy: "Điều khoản đặt lịch & chính sách huỷ",
        bookAgainPrompt: "Sẵn sàng đặt lần tiếp theo?", bookAgain: "📅 Đặt lại", poweredBy: "Được hỗ trợ bởi",
        platform: "Hệ thống đặt lịch AI cho salon",
        prep: "Chuẩn bị", lineTotal: "Tổng dịch vụ", originalServices: "Giá dịch vụ",
        promoDiscount: "Khuyến mãi", emailDiscount: "Ưu đãi email", voucherDiscount: "Voucher",
      }
    : {
        subtitle: "Booking Confirmed", location: "Location", directions: "📍 Get directions",
        addon: "Add-on", subtotal: "Subtotal", totalWithTax: "Total (incl. tax)", total: "Total",
        cardOnFile: "Card on file", cardDisclosure: "To hold your spot we securely saved your card",
        cardUse: "You're only charged", cardCondition: "if you don't show up — nothing otherwise.",
        manageCard: "Manage or remove card", allSet: "You're all set",
        confirmedAt: "Your appointment at", confirmedSuffix: "has been confirmed.", details: "Appointment Details",
        dateTime: "Date & Time", service: "Service", staff: "Staff", viewStatus: "View Booking Status",
        addCalendar: "📅 Add to calendar", calendarHint: "Apple Mail · Outlook: open the attached invite",
        needChange: "Need to make a change?", reschedule: "Reschedule", cancel: "Cancel",
        contactPrefix: "Need to reschedule? Contact", policy: "Booking terms & cancellation policy",
        bookAgainPrompt: "Ready to book your next visit?", bookAgain: "📅 Book Again", poweredBy: "Powered by",
        platform: "AI Booking System for Salons",
        prep: "Prep", lineTotal: "Service total", originalServices: "Services",
        promoDiscount: "Promotion", emailDiscount: "Email incentive", voucherDiscount: "Voucher",
      };
  const eName = escapeHtml(input.clientName);
  const eSalon = escapeHtml(salonName);
  const eService = escapeHtml(input.serviceName);
  const eAddon = input.addonServiceName ? escapeHtml(input.addonServiceName) : null;
  const eStaff = escapeHtml(input.staffName);
  const eDateTime = escapeHtml(dateTimeStr);
  const receiptCurrency = input.currencyCode || currencyCode;
  const servicePriceLabel = input.servicePriceCents != null
    ? formatCurrency(input.servicePriceCents, receiptCurrency)
    : null;

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
              <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#888;">${copy.location}</p>
              <p style="margin:0 0 12px;font-size:14px;color:#333;line-height:1.45;">${eAddress}</p>
              <a href="${mapsUrl}" style="display:inline-block;padding:9px 18px;background:#0B0C10;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:13px;">${copy.directions}</a>
            </div>`
    : "";

  const hasTaxBreakdown =
    Array.isArray(input.taxBreakdown) &&
    input.taxBreakdown.length > 0 &&
    input.subtotalCents != null &&
    input.subtotalCents > 0;

  // A discounted/free receipt still needs its subtotal and explicit $0 total.
  const displaySubtotalCents =
    input.subtotalCents != null &&
    (hasTaxBreakdown || (input.discountLines?.length ?? 0) > 0)
      ? input.subtotalCents
      : null;
  const displayTotalCents = input.totalPriceCents;

  const subtotalStr = displaySubtotalCents != null
    ? (formatCurrency(displaySubtotalCents, receiptCurrency) ?? null)
    : null;
  const priceStr = displayTotalCents != null && displayTotalCents >= 0
    ? (formatCurrency(displayTotalCents, receiptCurrency) ?? null)
    : null;

  const addonRow = input.addonLines?.length
    ? input.addonLines.map((line) => `<tr>
        <td style="padding:6px 0;color:#666;font-size:14px;width:120px;">${copy.addon}</td>
        <td style="padding:6px 0;font-size:14px;">${escapeHtml(line.name)} — ${escapeHtml(formatCurrency(line.priceCents, receiptCurrency) ?? "")}</td>
       </tr>`).join("")
    : eAddon ? `<tr>
        <td style="padding:6px 0;color:#666;font-size:14px;width:120px;">${copy.addon}</td>
        <td style="padding:6px 0;font-size:14px;">${eAddon}</td>
       </tr>`
    : "";

  const subtotalRow = subtotalStr
    ? `<tr>
        <td style="padding:6px 0;color:#666;font-size:14px;width:120px;">${copy.subtotal}</td>
        <td style="padding:6px 0;font-size:14px;">${escapeHtml(subtotalStr)}</td>
       </tr>`
    : "";

  const taxRows = hasTaxBreakdown
    ? input.taxBreakdown!
        .map((b) => {
          const taxStr = formatCurrency(b.amountCents, receiptCurrency) ?? "";
          const pct = (b.rate * 100).toFixed(b.rate * 100 === Math.round(b.rate * 100) ? 0 : 3).replace(/\.?0+$/, "");
          return `<tr>
        <td style="padding:6px 0;color:#666;font-size:14px;width:120px;">${escapeHtml(b.name)} (${pct}%)</td>
        <td style="padding:6px 0;font-size:14px;">+${escapeHtml(taxStr)}</td>
       </tr>`;
        })
        .join("")
    : "";

  const discountRows = input.discountLines?.map((line) => {
    const amount = formatCurrency(line.amountCents, receiptCurrency) ?? "";
    return `<tr>
        <td style="padding:6px 0;color:#666;font-size:14px;width:120px;">${escapeHtml(line.label)}</td>
        <td style="padding:6px 0;font-size:14px;">−${escapeHtml(amount)}</td>
       </tr>`;
  }).join("") ?? "";

  const priceRow = priceStr
    ? `${discountRows}${subtotalRow}${taxRows}<tr>
        <td style="padding:6px 0;color:#666;font-size:14px;width:120px;">${hasTaxBreakdown ? copy.totalWithTax : copy.total}</td>
        <td style="padding:6px 0;font-size:14px;font-weight:600;">${escapeHtml(priceStr)}</td>
       </tr>`
    : "";

  const sequenceRows = input.sequenceReceipt
    ? input.sequenceReceipt.segments.map((segment, index) => {
        const lineDateTime = input.sequenceLineDateTimes?.[index] ?? segment.serviceStartUtc;
        const lineDiscounts = segment.discountLines.map((line) => {
          const label = line.kind === "email_incentive"
            ? copy.emailDiscount
            : line.kind === "voucher" ? copy.voucherDiscount : line.label;
          return `<tr>
                  <td style="padding:3px 0 3px 18px;color:#777;font-size:13px;">${escapeHtml(label)}</td>
                  <td style="padding:3px 0;font-size:13px;">−${escapeHtml(formatCurrency(line.amountCents, input.sequenceReceipt!.currency) ?? "")}</td>
                </tr>`;
        }).join("");
        const lineAddons = segment.addonLines.map((line) => `<tr>
                  <td style="padding:3px 0 3px 18px;color:#777;font-size:13px;">${copy.addon}: ${escapeHtml(line.name)}</td>
                  <td style="padding:3px 0;font-size:13px;">${escapeHtml(formatCurrency(line.priceCents, input.sequenceReceipt!.currency) ?? "")}</td>
                </tr>`).join("");
        const lineTaxes = segment.taxBreakdown.map((line) => `<tr>
                  <td style="padding:3px 0 3px 18px;color:#777;font-size:13px;">${escapeHtml(line.name)}</td>
                  <td style="padding:3px 0;font-size:13px;">+${escapeHtml(formatCurrency(line.amountCents, input.sequenceReceipt!.currency) ?? "")}</td>
                </tr>`).join("");
        return `<tr>
                  <td colspan="2" style="padding:${index === 0 ? "6px" : "14px"} 0 5px;font-size:14px;font-weight:700;${index === 0 ? "" : "border-top:1px solid #eee;"}">
                    ${index + 1}. ${escapeHtml(segment.serviceName)}
                  </td>
                </tr>
                <tr><td style="padding:3px 0 3px 18px;color:#777;font-size:13px;">${copy.dateTime}</td><td style="padding:3px 0;font-size:13px;">${escapeHtml(lineDateTime)}</td></tr>
                <tr><td style="padding:3px 0 3px 18px;color:#777;font-size:13px;">${copy.staff}</td><td style="padding:3px 0;font-size:13px;">${escapeHtml(segment.staffName)}</td></tr>
                <tr><td style="padding:3px 0 3px 18px;color:#777;font-size:13px;">${copy.prep}</td><td style="padding:3px 0;font-size:13px;">${segment.prepMinutes} min</td></tr>
                <tr><td style="padding:3px 0 3px 18px;color:#777;font-size:13px;">${copy.service}</td><td style="padding:3px 0;font-size:13px;">${escapeHtml(formatCurrency(segment.serviceOriginalCents, input.sequenceReceipt!.currency) ?? "")}</td></tr>
                ${lineAddons}${lineDiscounts}${lineTaxes}
                <tr><td style="padding:4px 0 5px 18px;color:#555;font-size:13px;font-weight:600;">${copy.lineTotal}</td><td style="padding:4px 0 5px;font-size:13px;font-weight:700;">${escapeHtml(formatCurrency(segment.totalCents, input.sequenceReceipt!.currency) ?? "")}</td></tr>`;
      }).join("")
    : "";

  const sequenceSummaryRows = input.sequenceReceipt
    ? (() => {
        const receipt = input.sequenceReceipt;
        const addonOriginal = receipt.segments.reduce((sum, segment) => sum + segment.addonPreVoucherCents, 0);
        const rows = [
          [copy.originalServices, receipt.serviceOriginalCents, ""],
          ...(addonOriginal > 0 ? [[copy.addon, addonOriginal, ""]] : []),
          ...(receipt.promoDiscountCents > 0 ? [[copy.promoDiscount, receipt.promoDiscountCents, "−"]] : []),
          ...(receipt.emailDiscountCents > 0 ? [[copy.emailDiscount, receipt.emailDiscountCents, "−"]] : []),
          ...(receipt.voucherDiscountCents > 0 ? [[copy.voucherDiscount, receipt.voucherDiscountCents, "−"]] : []),
          [copy.subtotal, receipt.subtotalCents, ""],
        ] as [string, number, string][];
        return `<tr><td colspan="2" style="padding:14px 0 4px;border-top:2px solid #ddd;font-size:13px;font-weight:700;">${copy.total}</td></tr>
          ${rows.map(([label, amount, prefix]) => `<tr><td style="padding:3px 0;color:#666;font-size:13px;">${escapeHtml(label)}</td><td style="padding:3px 0;font-size:13px;">${prefix}${escapeHtml(formatCurrency(amount, receipt.currency) ?? "")}</td></tr>`).join("")}
          ${receipt.taxBreakdown.map((line) => `<tr><td style="padding:3px 0;color:#666;font-size:13px;">${escapeHtml(line.name)}</td><td style="padding:3px 0;font-size:13px;">+${escapeHtml(formatCurrency(line.amountCents, receipt.currency) ?? "")}</td></tr>`).join("")}
          <tr><td style="padding:5px 0;font-size:14px;font-weight:700;">${receipt.taxBreakdown.length > 0 ? copy.totalWithTax : copy.total}</td><td style="padding:5px 0;font-size:14px;font-weight:700;">${escapeHtml(formatCurrency(receipt.totalCents, receipt.currency) ?? "")}</td></tr>`;
      })()
    : "";

  // Saved-card disclosure. Card-network stored-credential rules require us to
  // tell the cardholder we kept their card on file, what it'll be used for, and
  // give them a way to remove it. Display brand + last4 only (never the PAN).
  const cardBlock = savedCard
    ? `<div style="margin:18px 0 0;padding:16px;border:1px solid #e6e0cf;border-radius:8px;background:#fbf8ef;">
              <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9a8a52;">${copy.cardOnFile}</p>
              <p style="margin:0 0 8px;font-size:14px;color:#333;line-height:1.45;">
                ${copy.cardDisclosure} <strong>${escapeHtml(savedCard.brand || "card")} •••• ${escapeHtml(savedCard.last4)}</strong>.
                ${copy.cardUse} <strong>${escapeHtml(savedCard.feeLabel)}</strong> ${copy.cardCondition}
              </p>
              <a href="${savedCard.manageUrl}" style="display:inline-block;padding:9px 18px;background:#0B0C10;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:13px;">${copy.manageCard}</a>
            </div>`
    : "";

  return `<!doctype html>
<html lang="${locale}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.07);">

        <!-- Header -->
        <tr>
          <td style="background:#0B0C10;padding:24px 32px;text-align:center;">
            ${buildEmailBrandHeader({ salonName, logoUrl: salonLogoUrl, subtitle: copy.subtitle })}
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:28px 32px;">
            <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;">${copy.allSet}, ${eName}! ✓</h1>
            <p style="margin:0 0 24px;color:#555;font-size:15px;">${copy.confirmedAt} <strong>${eSalon}</strong> ${copy.confirmedSuffix}</p>

            <!-- Booking details -->
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:8px;overflow:hidden;">
              <tr>
                <td colspan="2" style="background:#fafafa;padding:12px 16px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#888;border-bottom:1px solid #eee;">
                  ${copy.details}
                </td>
              </tr>
              <tr><td style="padding:0 16px 0;"><table width="100%" cellpadding="0" cellspacing="0" style="padding:12px 0;">
                ${input.sequenceReceipt ? `${sequenceRows}${sequenceSummaryRows}` : `<tr>
                  <td style="padding:6px 0;color:#666;font-size:14px;width:120px;">${copy.dateTime}</td>
                  <td style="padding:6px 0;font-size:14px;font-weight:600;">${eDateTime}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#666;font-size:14px;">${copy.service}</td>
                  <td style="padding:6px 0;font-size:14px;">${eService}${servicePriceLabel ? ` — ${escapeHtml(servicePriceLabel)}` : ""}</td>
                </tr>
                ${addonRow}
                <tr>
                  <td style="padding:6px 0;color:#666;font-size:14px;">${copy.staff}</td>
                  <td style="padding:6px 0;font-size:14px;">${eStaff}</td>
                </tr>
                ${priceRow}`}
              </table></td></tr>
            </table>

            <!-- Location + directions -->
            ${locationBlock}

            <!-- Saved card on file -->
            ${cardBlock}

            <!-- CTA -->
            <div style="margin:24px 0 0;text-align:center;">
              <a href="${confirmUrl}" style="display:inline-block;padding:12px 28px;background:#D4AF37;color:#0B0C10;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;">
                ${copy.viewStatus}
              </a>
            </div>
            ${
              calendarUrl
                ? `<!-- Add to calendar -->
            <div style="margin:12px 0 0;text-align:center;">
              <a href="${calendarUrl}" style="display:inline-block;padding:10px 24px;border:1px solid #ddd;color:#0B0C10;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">
                ${copy.addCalendar}
              </a>
              <p style="margin:6px 0 0;font-size:11px;color:#aaa;">${copy.calendarHint}</p>
            </div>`
                : ""
            }

            ${
              manageLinks
                ? `<p style="margin:20px 0 0;font-size:13px;color:#888;text-align:center;">
              ${copy.needChange}
              <a href="${manageLinks.reschedule}" style="color:#0B0C10;font-weight:600;text-decoration:underline;">${copy.reschedule}</a>
              &nbsp;·&nbsp;
              <a href="${manageLinks.cancel}" style="color:#0B0C10;font-weight:600;text-decoration:underline;">${copy.cancel}</a>
            </p>`
                : `<p style="margin:20px 0 0;font-size:13px;color:#888;text-align:center;">
              ${copy.contactPrefix} <strong>${eSalon}</strong>${ePhone && telHref ? ` · <a href="tel:${telHref}" style="color:#0B0C10;font-weight:600;text-decoration:underline;">${ePhone}</a>` : ""}.
            </p>`
            }
            ${
              policyUrl
                ? `<p style="margin:8px 0 0;font-size:12px;color:#aaa;text-align:center;">
              <a href="${policyUrl}" style="color:#aaa;text-decoration:underline;">${copy.policy}</a>
            </p>`
                : ""
            }

            <!-- Book again — pre-filled link so returning visit is 2 taps -->
            ${
              bookAgainUrl
                ? `<div style="margin:20px 0 0;padding:16px;border-radius:8px;background:#f7f7f7;text-align:center;">
              <p style="margin:0 0 10px;font-size:13px;color:#555;">${copy.bookAgainPrompt}</p>
              <a href="${bookAgainUrl}" style="display:inline-block;padding:10px 22px;border:2px solid #0B0C10;color:#0B0C10;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;">
                ${copy.bookAgain}
              </a>
            </div>`
                : ""
            }
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#fafafa;border-top:1px solid #eee;padding:16px 32px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#aaa;">
              ${copy.poweredBy} <a href="https://nailiq.ca" style="color:#aaa;">NailIQ</a> — ${copy.platform}
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

  console.log("[sendBookingConfirmationEmail] sending to", input.clientEmail, "booking", input.bookingId);

  try {
    const supabase = createServiceRoleClient();
    const { data: salonRow } = await supabase
      .from("salons")
      .select("id, name, timezone, currency_code, reminders_enabled, address, salon_phone, email, logo_url")
      .eq("slug", input.shopSlug)
      .maybeSingle();

    const salonName = (salonRow?.name as string | null | undefined)?.trim() || input.shopSlug;
    const timezone =
      typeof salonRow?.timezone === "string" && salonRow.timezone.trim()
        ? salonRow.timezone.trim()
        : "America/Vancouver";
    const currencyCode =
      typeof salonRow?.currency_code === "string" && salonRow.currency_code.trim()
        ? salonRow.currency_code.trim()
        : "CAD";

    const salonId =
      typeof salonRow?.id === "string" ? salonRow.id : null;

    if (!salonId) {
      console.error("[sendBookingConfirmationEmail] salon unavailable; email not claimed");
      return;
    }
    const sequenceLoad = await loadBookingSequenceReceipt({
      salonId,
      bookingId: input.bookingId,
    });
    if (!sequenceLoad.ok && sequenceLoad.code !== "not_sequence") {
      console.error("[sendBookingConfirmationEmail] authoritative sequence receipt unavailable");
      return;
    }
    if (sequenceLoad.ok && sequenceLoad.receipt.status !== "confirmed") {
      console.error("[sendBookingConfirmationEmail] sequence booking is not confirmed");
      return;
    }
    const sequenceReceipt = sequenceLoad.ok ? sequenceLoad.receipt : null;
    const effectiveInput: BookingConfirmationInput = sequenceReceipt
      ? {
          ...input,
          serviceName: sequenceReceipt.segments.map((segment) => segment.serviceName).join(" + "),
          staffName: [...new Set(sequenceReceipt.segments.map((segment) => segment.staffName))].join(", "),
          startTimeUtc: sequenceReceipt.parentStartTimeUtc,
          totalPriceCents: sequenceReceipt.totalCents,
          subtotalCents: sequenceReceipt.subtotalCents,
          taxBreakdown: sequenceReceipt.taxBreakdown,
          currencyCode: sequenceReceipt.currency,
          sequenceReceipt,
          sequenceLineDateTimes: sequenceReceipt.segments.map((segment) =>
            formatDateTimeForEmail(segment.serviceStartUtc, timezone, normalizeEmailLocale(input.clientLocale))),
        }
      : { ...input, sequenceReceipt: null };

    const clientLocale = normalizeEmailLocale(input.clientLocale);
    const localizedInput = { ...effectiveInput, clientLocale };
    const dateTimeStr = formatDateTimeForEmail(effectiveInput.startTimeUtc, timezone, clientLocale);
    // Self-serve reschedule/cancel links — gated on the salon's existing
    // customer self-service opt-in (`reminders_enabled`, the same switch that
    // already puts these links in reminder emails). Token expires a short grace
    // after the appointment so the link works right up to the visit, not 48h
    // after booking. Best-effort: if the token can't be minted we fall back to
    // the "contact the salon" copy.
    let manageLinks: ManageLinks | null = null;
    let savedCard: SavedCardInfo | null = null;

    // Look up a saved no-show card so we can disclose it + offer removal. The
    // card-management link is a stored-credential requirement, so we mint a
    // token whenever a card is on file — even if reschedule/cancel self-service
    // (reminders_enabled) is off.
    const { data: cardRow } = await supabase
      .from("bookings")
      .select("noshow_card_id, noshow_card_last4, noshow_card_brand, noshow_fee_cents, end_time_utc")
      .eq("id", input.bookingId)
      .maybeSingle();
    const hasCard = Boolean((cardRow as { noshow_card_id?: string | null } | null)?.noshow_card_id);
    const bookingEndUtc =
      typeof (cardRow as { end_time_utc?: string | null } | null)?.end_time_utc === "string"
        ? String((cardRow as { end_time_utc: string }).end_time_utc)
        : null;

    const startMs = Date.parse(effectiveInput.startTimeUtc);
    const expiresAt = Number.isFinite(startMs)
      ? new Date(startMs + SELF_SERVE_GRACE_MS).toISOString()
      : undefined;
    const origin = getEmailOrigin();
    const statusToken = salonId
      ? await generateReminderToken(input.bookingId, salonId, { action: "status", expiresAt })
      : null;
    const confirmUrl = buildConfirmationUrl(input.shopSlug, statusToken?.id);

    if (salonId && salonRow?.reminders_enabled === true) {
      const [rescheduleToken, cancelToken] = await Promise.all([
        generateReminderToken(input.bookingId, salonId, { action: "reschedule", expiresAt }),
        generateReminderToken(input.bookingId, salonId, { action: "cancel", expiresAt }),
      ]);
      if (rescheduleToken && cancelToken) {
        manageLinks = {
          reschedule: `${origin}/booking/reschedule?token=${rescheduleToken.id}`,
          cancel: `${origin}/booking/cancel?token=${cancelToken.id}`,
        };
      }
    }

    if (salonId && hasCard) {
      const cardToken = await generateReminderToken(input.bookingId, salonId, {
        action: "card_manage",
        expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      });
      if (cardToken) {
        const c = cardRow as {
          noshow_card_last4?: string | null;
          noshow_card_brand?: string | null;
          noshow_fee_cents?: number | null;
        };
        savedCard = {
          brand: c.noshow_card_brand ?? "",
          last4: c.noshow_card_last4 ?? "",
          feeLabel: formatCurrency(c.noshow_fee_cents ?? 0, currencyCode) ?? `${((c.noshow_fee_cents ?? 0) / 100).toFixed(2)} ${currencyCode}`,
          manageUrl: `${origin}/booking/card?token=${cardToken.id}`,
        };
      }
    }

    const address =
      typeof salonRow?.address === "string" ? salonRow.address : null;
    const salonPhone =
      typeof salonRow?.salon_phone === "string" ? salonRow.salon_phone : null;
    // Owner/booking reply email: customers who hit Reply should reach the salon,
    // not noreply@nailiq.ca. We use the salon's auth email as a best-effort
    // replyTo — if not set, we omit it and the customer's reply goes to From.
    const salonReplyEmailCandidate =
      typeof (salonRow as { email?: unknown } | null)?.email === "string"
        ? String((salonRow as { email: string }).email).trim() || null
        : null;
    const salonReplyEmail = salonReplyEmailCandidate?.includes("@") &&
      !/[\u0000-\u001f\u007f]/.test(salonReplyEmailCandidate)
      ? salonReplyEmailCandidate
      : null;
    const salonLogoUrl = normalizeEmailLogoUrl(
      (salonRow as { logo_url?: unknown } | null)?.logo_url,
    );

    // "Add to calendar" — drops the appointment into the customer's phone
    // calendar in one tap (a real no-show reducer). Google link for Gmail/Android
    // + an .ics attachment that Apple Mail / Outlook auto-detect. Calendar
    // artifacts require the authoritative persisted end time; never invent a
    // duration when that read is unavailable.
    const endUtcCal =
      bookingEndUtc ?? sequenceReceipt?.parentEndTimeUtc ?? null;
    const calTitle = `${effectiveInput.serviceName} · ${salonName}`;
    const calDetails = `${effectiveInput.serviceName}${effectiveInput.staffName ? ` with ${effectiveInput.staffName}` : ""} at ${salonName}. Manage: ${confirmUrl}`;
    const calendarUrl = endUtcCal ? googleCalendarUrl({
      title: calTitle, startUtc: effectiveInput.startTimeUtc, endUtc: endUtcCal, location: address, details: calDetails,
    }) : null;
    const icsContent = endUtcCal ? buildIcs({
      uid: `${input.bookingId}@nailiq.ca`,
      title: calTitle, startUtc: effectiveInput.startTimeUtc, endUtc: endUtcCal, location: address, details: calDetails,
    }) : null;

    // "Book again" — pre-filled URL so the customer can rebook in 2 taps.
    // The slug + pre-fill query params skip name/phone entry for returning customers.
    const bookAgainUrl = `${getEmailOrigin()}/${input.shopSlug}?ref=email_confirm`;

    const html = buildHtml(
      salonName,
      localizedInput,
      dateTimeStr,
      confirmUrl,
      currencyCode,
      manageLinks,
      address,
      salonPhone,
      savedCard,
      calendarUrl,
      `${getEmailOrigin()}/${input.shopSlug}/booking-terms`,
      bookAgainUrl,
      salonLogoUrl,
    );

    // CASL: sender ID + physical mailing address + unsubscribe in every email.
    // Booking confirmation is transactional → always sent (no suppression check),
    // but still carries the compliance footer + List-Unsubscribe header.
    const to = input.clientEmail.trim();
    const htmlWithFooter = html.replace(
      "</body>",
      `${complianceFooterHtml({ email: to, salonName, salonAddress: address, lang: clientLocale, transactional: true })}</body>`,
    );

    const result = await deliverBookingConfirmation({
      bookingId: input.bookingId,
      salonId,
      envelope: {
        v: 1,
        channel: "email",
        salonId,
        from: getResendFrom(),
        to,
        subject: buildBookingConfirmationSubject(salonName, clientLocale),
        html: htmlWithFooter,
        headers: listUnsubscribeHeaders(to),
        replyTo: salonReplyEmail,
        // .ics attachment → Apple Mail / Outlook show a one-tap "Add to Calendar".
        attachments: icsContent
          ? [{
              filename: "appointment.ics",
              content: Buffer.from(icsContent, "utf-8").toString("base64"),
              contentType: "text/calendar; method=PUBLISH",
            }]
          : [],
      },
    });
    if (result.outcome === "accepted" && result.finalized) {
      console.log("[sendBookingConfirmationEmail] sent ok id=", result.providerMessageId);
    } else if (result.reason !== "duplicate_terminal") {
      console.error("[sendBookingConfirmationEmail] delivery incomplete", {
        bookingId: input.bookingId,
        outcome: result.outcome,
        reason: result.reason,
        finalized: result.finalized,
      });
    }
  } catch (e) {
    console.error("[sendBookingConfirmationEmail] threw", e);
  }
}
