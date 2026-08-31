import "server-only";

import {
  buildEmailBrandHeader,
  escapeEmailHtml,
  type EmailLocale,
} from "@/shared/booking/emailBranding";
import {
  complianceFooterHtml,
  listUnsubscribeHeaders,
} from "@/shared/lib/emailCompliance";
import {
  emailExperienceTags,
  emailExperienceDefinition,
  type EmailExperienceKey,
} from "@/shared/lib/emailExperienceRegistry";

export type EmailExperienceDetail = {
  label: string;
  value: string;
};

export type EmailExperienceAction = {
  label: string;
  url: string;
  kind?: "primary" | "secondary";
};

export type BuildEmailExperienceInput = {
  key: EmailExperienceKey;
  locale?: EmailLocale;
  subject: string;
  preheader: string;
  salonName: string;
  salonLogoUrl?: string | null;
  salonAddress?: string | null;
  recipientEmail: string;
  badge: string;
  heading: string;
  greeting?: string | null;
  paragraphs?: readonly string[];
  details?: readonly EmailExperienceDetail[];
  callout?: { title: string; body: string } | null;
  code?: string | null;
  actions?: readonly EmailExperienceAction[];
  note?: string | null;
};

export type BuiltEmailExperience = {
  html: string;
  text: string;
  headers: Record<string, string>;
  tags: Array<{ name: string; value: string }>;
};

function safeActionUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw || raw.length > 2_048) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if (url.protocol === "https:") return url.toString();
    if (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)) {
      return url.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function subtitleFor(key: EmailExperienceKey, locale: EmailLocale): string {
  const definition = emailExperienceDefinition(key);
  if (definition.audience === "security") {
    return locale === "vi" ? "XÁC MINH AN TOÀN" : "SECURE VERIFICATION";
  }
  if (definition.audience === "owner") {
    return locale === "vi" ? "NAILIQ OWNER CONCIERGE" : "NAILIQ OWNER CONCIERGE";
  }
  return locale === "vi" ? "NAILIQ SALON CONCIERGE" : "NAILIQ SALON CONCIERGE";
}

export function buildEmailExperience(input: BuildEmailExperienceInput): BuiltEmailExperience {
  const locale = input.locale === "vi" ? "vi" : "en";
  const definition = emailExperienceDefinition(input.key);
  const details = input.details ?? [];
  const paragraphs = input.paragraphs ?? [];
  const actions = (input.actions ?? [])
    .map((action) => ({ ...action, safeUrl: safeActionUrl(action.url) }))
    .filter((action): action is EmailExperienceAction & { safeUrl: string } => Boolean(action.safeUrl));
  const transactional = definition.consent === "transactional";
  const optionalCustomer = definition.audience === "customer" || definition.audience === "security";
  const greeting = input.greeting?.trim() ?? "";

  const detailRows = details.map((detail) =>
    `<tr><td style="padding:7px 0;color:#666;font-size:14px;width:118px;vertical-align:top;">${escapeEmailHtml(detail.label)}</td><td style="padding:7px 0;font-size:14px;font-weight:650;">${escapeEmailHtml(detail.value)}</td></tr>`
  ).join("");
  const paragraphHtml = paragraphs.map((paragraph) =>
    `<p style="margin:0 0 14px;color:#555;font-size:15px;line-height:1.6;">${escapeEmailHtml(paragraph)}</p>`
  ).join("");
  const calloutHtml = input.callout
    ? `<div style="margin:18px 0 0;padding:15px 16px;border-left:4px solid #D4AF37;background:#fbf8ef;border-radius:8px;"><p style="margin:0 0 5px;font-size:13px;font-weight:800;color:#50420f;">${escapeEmailHtml(input.callout.title)}</p><p style="margin:0;color:#5f5a4a;font-size:13px;line-height:1.5;">${escapeEmailHtml(input.callout.body)}</p></div>`
    : "";
  const codeHtml = input.code?.trim()
    ? `<div style="margin:18px 0 0;padding:16px;text-align:center;background:#0B0C10;color:#fff;border-radius:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:28px;font-weight:800;letter-spacing:.18em;">${escapeEmailHtml(input.code.trim())}</div>`
    : "";
  const actionsHtml = actions.length
    ? `<div style="margin:22px 0 0;text-align:center;">${actions.map((action) => {
      const secondary = action.kind === "secondary";
      const style = secondary
        ? "border:1px solid #0B0C10;color:#0B0C10;background:#fff;"
        : "border:1px solid #D4AF37;color:#0B0C10;background:#D4AF37;";
      return `<a href="${escapeEmailHtml(action.safeUrl)}" style="display:inline-block;margin:6px 4px 0;padding:12px 22px;${style}border-radius:8px;text-decoration:none;font-size:14px;font-weight:800;">${escapeEmailHtml(action.label)}</a>`;
    }).join("")}</div>`
    : "";
  const noteHtml = input.note?.trim()
    ? `<p style="margin:16px 0 0;text-align:center;color:#777;font-size:12px;line-height:1.5;">${escapeEmailHtml(input.note.trim())}</p>`
    : "";
  const footerHtml = optionalCustomer
    ? complianceFooterHtml({
      email: input.recipientEmail,
      salonName: input.salonName,
      salonAddress: input.salonAddress,
      lang: locale,
      transactional,
      context: definition.audience === "security"
        ? "security"
        : input.key === "waitlist_offer" || input.key === "waitlist_offer_legacy"
          ? "waitlist"
          : definition.consent === "marketing"
            ? "marketing"
            : "appointment",
    })
    : "";

  const textLines = [
    greeting || null,
    input.heading,
    ...paragraphs,
    ...details.map((detail) => `${detail.label}: ${detail.value}`),
    input.callout ? `${input.callout.title}: ${input.callout.body}` : null,
    input.code?.trim() ? `${locale === "vi" ? "Mã" : "Code"}: ${input.code.trim()}` : null,
    ...actions.map((action) => `${action.label}: ${action.safeUrl}`),
    input.note?.trim() || null,
  ].filter((line): line is string => Boolean(line));

  return {
    text: textLines.join("\n\n"),
    headers: optionalCustomer ? listUnsubscribeHeaders(input.recipientEmail) : {},
    tags: emailExperienceTags(input.key),
    html: `<!doctype html>
<html lang="${locale}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeEmailHtml(input.subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeEmailHtml(input.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.07);">
        <tr><td style="background:#0B0C10;padding:24px 28px;text-align:center;">${buildEmailBrandHeader({ salonName: input.salonName, logoUrl: input.salonLogoUrl, subtitle: subtitleFor(input.key, locale) })}</td></tr>
        <tr><td style="padding:28px;">
          <span style="display:inline-block;margin:0 0 14px;padding:5px 9px;border-radius:999px;background:#fbf8ef;color:#7a6420;font-size:11px;font-weight:800;letter-spacing:.08em;">${escapeEmailHtml(input.badge)}</span>
          ${greeting ? `<p style="margin:0 0 7px;color:#555;font-size:15px;">${escapeEmailHtml(greeting)}</p>` : ""}
          <h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;font-weight:750;color:#111;">${escapeEmailHtml(input.heading)}</h1>
          ${paragraphHtml}
          ${details.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 0;border:1px solid #eee;border-radius:10px;"><tr><td style="padding:12px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${detailRows}</table></td></tr></table>` : ""}
          ${calloutHtml}
          ${codeHtml}
          ${actionsHtml}
          ${noteHtml}
          ${footerHtml}
        </td></tr>
        <tr><td style="padding:15px 24px;background:#fafafa;border-top:1px solid #eee;text-align:center;color:#999;font-size:11px;">Powered by NailIQ · AI-assisted salon operations</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  };
}
