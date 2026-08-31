import "server-only";

import {
  buildEmailBrandHeader,
  escapeEmailHtml,
} from "@/shared/booking/emailBranding";
import { complianceFooterHtml } from "@/shared/lib/emailCompliance";
import type { SupportedLocale } from "@/shared/notifications/resolveCustomerLocale";

export type CustomerAppointmentEmailEvent =
  | "create"
  | "reschedule"
  | "cancel"
  | "staff_change";

export type CustomerAppointmentEmailInput = {
  event: CustomerAppointmentEmailEvent;
  locale: SupportedLocale;
  subject: string;
  recipientEmail: string;
  clientName: string;
  salonName: string;
  salonSlug?: string | null;
  salonLogoUrl?: string | null;
  salonPhone?: string | null;
  serviceName: string;
  staffName?: string | null;
  whenLabel: string;
  previousWhenLabel?: string | null;
  siteUrl: string;
};

type EventCopy = {
  subtitle: string;
  badge: string;
  heading: string;
  intro: string;
  primaryAction: string;
  truth: string;
};

function copyForEvent(
  event: CustomerAppointmentEmailEvent,
  locale: SupportedLocale,
): EventCopy {
  if (locale === "vi") {
    switch (event) {
      case "create":
        return {
          subtitle: "Lịch hẹn đã xác nhận",
          badge: "ĐÃ XÁC NHẬN",
          heading: "Lịch hẹn của bạn đã sẵn sàng",
          intro: "Tiệm đã xác nhận lịch hẹn dưới đây.",
          primaryAction: "Xem tiệm",
          truth: "Email này xác nhận lịch hẹn, không phải biên nhận thanh toán.",
        };
      case "reschedule":
        return {
          subtitle: "Lịch hẹn đã được dời",
          badge: "ĐÃ CẬP NHẬT",
          heading: "Lịch hẹn của bạn có giờ mới",
          intro: "Tiệm đã cập nhật lịch hẹn theo thông tin dưới đây.",
          primaryAction: "Xem tiệm",
          truth: "Giờ mới được lấy từ hồ sơ lịch hẹn đã lưu của tiệm.",
        };
      case "cancel":
        return {
          subtitle: "Lịch hẹn đã huỷ",
          badge: "ĐÃ HUỶ",
          heading: "Lịch hẹn này đã được huỷ",
          intro: "Bạn không cần làm gì thêm cho lịch hẹn này.",
          primaryAction: "Đặt giờ mới",
          truth: "Email này không xác nhận phí hoặc hoàn tiền. Mọi khoản tiền phải có thông báo thanh toán riêng.",
        };
      case "staff_change":
        return {
          subtitle: "Nhân viên phục vụ đã được cập nhật",
          badge: "CẬP NHẬT NHÂN VIÊN",
          heading: "Nhân viên phục vụ đã thay đổi",
          intro: "Ngày và giờ của lịch hẹn vẫn giữ nguyên.",
          primaryAction: "Xem tiệm",
          truth: "Cập nhật này được tạo từ hồ sơ lịch hẹn đã lưu của tiệm.",
        };
    }
  }

  switch (event) {
    case "create":
      return {
        subtitle: "Appointment Confirmed",
        badge: "CONFIRMED",
        heading: "Your appointment is all set",
        intro: "The salon confirmed the appointment below.",
        primaryAction: "View salon",
        truth: "This email confirms the appointment, not a payment receipt.",
      };
    case "reschedule":
      return {
        subtitle: "Appointment Rescheduled",
        badge: "UPDATED",
        heading: "Your appointment has a new time",
        intro: "The salon updated your appointment with the details below.",
        primaryAction: "View salon",
        truth: "The new time comes from the salon's saved appointment record.",
      };
    case "cancel":
      return {
        subtitle: "Appointment Cancelled",
        badge: "CANCELLED",
        heading: "Your appointment has been cancelled",
        intro: "No further action is required for this appointment.",
        primaryAction: "Book a new time",
        truth: "This email does not confirm a fee or refund. Any money movement requires a separate payment notice.",
      };
    case "staff_change":
      return {
        subtitle: "Appointment Provider Updated",
        badge: "TEAM UPDATE",
        heading: "Your service provider changed",
        intro: "Your appointment date and time remain the same.",
        primaryAction: "View salon",
        truth: "This update was created from the salon's saved appointment record.",
      };
  }
}

function validSiteUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function customerEmailSiteUrl(): string {
  const configured = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  if (configured) return configured;
  const vercelUrl = (process.env.VERCEL_URL ?? "").trim();
  return vercelUrl ? `https://${vercelUrl}` : "https://nailiq.ca";
}

export function buildCustomerAppointmentEmail(
  input: CustomerAppointmentEmailInput,
): { html: string; text: string } | null {
  const siteUrl = validSiteUrl(input.siteUrl);
  if (!siteUrl) return null;
  const copy = copyForEvent(input.event, input.locale);
  const salonSlug = input.salonSlug?.trim() ?? "";
  const salonUrl = salonSlug
    ? new URL(`/${encodeURIComponent(salonSlug)}`, siteUrl).toString()
    : siteUrl.toString();
  const policyUrl = salonSlug
    ? new URL(`/${encodeURIComponent(salonSlug)}/booking-terms`, siteUrl).toString()
    : null;
  const phone = (input.salonPhone ?? "").trim();
  const tel = phone ? phone.replace(/[^\d+]/g, "") : "";
  const name = input.clientName.trim();
  const greeting = input.locale === "vi"
    ? name ? `Chào ${name},` : "Xin chào,"
    : name ? `Hi ${name},` : "Hello,";
  const labels = input.locale === "vi"
    ? {
        details: "CHI TIẾT LỊCH HẸN",
        dateTime: "Ngày & giờ",
        salon: "Tiệm",
        previousTime: "Giờ trước đó",
        service: "Dịch vụ",
        staff: "Nhân viên",
        contact: "Gọi tiệm",
        policy: "Điều khoản đặt lịch & chính sách huỷ",
        smartTitle: "NailIQ Booking Check",
        smartBody: "Cập nhật này được tạo từ hồ sơ lịch hẹn đã xác nhận của tiệm; không có giờ, giá hoặc chính sách nào do AI tự suy đoán.",
        poweredBy: "Được hỗ trợ bởi NailIQ · hệ thống đặt lịch có AI cho salon",
      }
    : {
        details: "APPOINTMENT DETAILS",
        dateTime: "Date & time",
        salon: "Salon",
        previousTime: "Previous time",
        service: "Service",
        staff: "Staff",
        contact: "Call salon",
        policy: "Booking terms & cancellation policy",
        smartTitle: "NailIQ Booking Check",
        smartBody: "This update is generated from the salon's confirmed appointment record; no time, price, or policy is invented by AI.",
        poweredBy: "Powered by NailIQ · AI-assisted booking for salons",
      };
  const previousRow = input.previousWhenLabel
    ? `<tr><td style="padding:7px 0;color:#777;font-size:14px;width:118px;">${labels.previousTime}</td><td style="padding:7px 0;color:#777;font-size:14px;text-decoration:line-through;">${escapeEmailHtml(input.previousWhenLabel)}</td></tr>`
    : "";
  const staffRow = input.staffName?.trim()
    ? `<tr><td style="padding:7px 0;color:#666;font-size:14px;width:118px;">${labels.staff}</td><td style="padding:7px 0;font-size:14px;">${escapeEmailHtml(input.staffName.trim())}</td></tr>`
    : "";
  const phoneButton = phone && tel
    ? `<a href="tel:${escapeEmailHtml(tel)}" style="display:inline-block;margin:8px 5px 0;padding:11px 20px;border:1px solid #0B0C10;border-radius:8px;color:#0B0C10;text-decoration:none;font-size:14px;font-weight:700;">${labels.contact}</a>`
    : "";
  const textLines = [
    greeting,
    copy.heading,
    copy.intro,
    "",
    `${labels.dateTime}: ${input.whenLabel}`,
    input.previousWhenLabel ? `${labels.previousTime}: ${input.previousWhenLabel}` : null,
    `${labels.salon}: ${input.salonName}`,
    `${labels.service}: ${input.serviceName}`,
    input.staffName?.trim() ? `${labels.staff}: ${input.staffName.trim()}` : null,
    "",
    copy.truth,
    phone ? `${labels.contact}: ${phone}` : null,
    `${copy.primaryAction}: ${salonUrl}`,
    policyUrl ? `${labels.policy}: ${policyUrl}` : null,
  ].filter((line): line is string => line !== null);

  return {
    text: textLines.join("\n"),
    html: `<!doctype html>
<html lang="${input.locale}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeEmailHtml(input.subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeEmailHtml(copy.heading)} · ${escapeEmailHtml(input.whenLabel)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.07);">
        <tr><td style="background:#0B0C10;padding:24px 28px;text-align:center;">${buildEmailBrandHeader({ salonName: input.salonName, logoUrl: input.salonLogoUrl, subtitle: copy.subtitle })}</td></tr>
        <tr><td style="padding:28px;">
          <span style="display:inline-block;margin:0 0 14px;padding:5px 9px;border-radius:999px;background:#fbf8ef;color:#7a6420;font-size:11px;font-weight:800;letter-spacing:.08em;">${copy.badge}</span>
          <p style="margin:0 0 7px;color:#555;font-size:15px;">${escapeEmailHtml(greeting)}</p>
          <h1 style="margin:0 0 9px;font-size:24px;line-height:1.25;font-weight:750;color:#111;">${copy.heading}</h1>
          <p style="margin:0 0 22px;color:#555;font-size:15px;line-height:1.55;">${copy.intro}</p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:10px;overflow:hidden;">
            <tr><td style="background:#fafafa;padding:12px 16px;border-bottom:1px solid #eee;color:#777;font-size:11px;font-weight:800;letter-spacing:.08em;">${labels.details}</td></tr>
            <tr><td style="padding:12px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${previousRow}
              <tr><td style="padding:7px 0;color:#666;font-size:14px;width:118px;">${labels.dateTime}</td><td style="padding:7px 0;font-size:14px;font-weight:700;">${escapeEmailHtml(input.whenLabel)}</td></tr>
              <tr><td style="padding:7px 0;color:#666;font-size:14px;width:118px;">${labels.salon}</td><td style="padding:7px 0;font-size:14px;">${escapeEmailHtml(input.salonName)}</td></tr>
              <tr><td style="padding:7px 0;color:#666;font-size:14px;width:118px;">${labels.service}</td><td style="padding:7px 0;font-size:14px;">${escapeEmailHtml(input.serviceName)}</td></tr>
              ${staffRow}
            </table></td></tr>
          </table>

          <div style="margin:18px 0 0;padding:15px 16px;border-left:4px solid #D4AF37;background:#fbf8ef;border-radius:8px;">
            <p style="margin:0 0 5px;font-size:13px;font-weight:800;color:#50420f;">${labels.smartTitle}</p>
            <p style="margin:0;color:#5f5a4a;font-size:13px;line-height:1.5;">${labels.smartBody}</p>
            <p style="margin:7px 0 0;color:#5f5a4a;font-size:13px;line-height:1.5;">${copy.truth}</p>
          </div>

          <div style="margin:22px 0 0;text-align:center;">
            <a href="${salonUrl}" style="display:inline-block;margin:8px 5px 0;padding:12px 22px;background:#D4AF37;border-radius:8px;color:#0B0C10;text-decoration:none;font-size:14px;font-weight:800;">${copy.primaryAction}</a>
            ${phoneButton}
          </div>
          ${policyUrl ? `<p style="margin:16px 0 0;text-align:center;font-size:12px;"><a href="${policyUrl}" style="color:#777;text-decoration:underline;">${labels.policy}</a></p>` : ""}

          ${complianceFooterHtml({ email: input.recipientEmail, salonName: input.salonName, lang: input.locale, transactional: true })}
        </td></tr>
        <tr><td style="padding:15px 24px;background:#fafafa;border-top:1px solid #eee;text-align:center;color:#999;font-size:11px;">${labels.poweredBy}</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  };
}
