import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { buildEmailBrandHeader } from "@/shared/booking/emailBranding";
import { complianceFooterHtml } from "@/shared/lib/emailCompliance";

const httpsUrl = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => value.startsWith("https://"), "https_required");

export const bulkEmailCampaignInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  subject: z.string().trim().min(1).max(150).refine((value) => !/[\r\n]/.test(value), "invalid_subject"),
  preheader: z.string().trim().max(180).default(""),
  headline: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(4000),
  imageUrl: z.union([z.literal(""), httpsUrl]).default(""),
  ctaLabel: z.string().trim().min(1).max(60),
  ctaUrl: httpsUrl,
  canarySize: z.coerce.number().int().min(1).max(100).default(25),
  batchSize: z.coerce.number().int().min(1).max(100).default(100),
  sendAfter: z.union([z.literal(""), z.string().datetime({ offset: true })]).default(""),
});

export type BulkEmailCampaignInput = z.infer<typeof bulkEmailCampaignInputSchema>;

export function bulkEmailContentFingerprint(input: BulkEmailCampaignInput): string {
  const normalized = bulkEmailCampaignInputSchema.parse(input);
  return createHash("sha256")
    .update(JSON.stringify({ version: "bulk-email-content-v1", ...normalized }), "utf8")
    .digest("hex");
}

export type BulkEmailRenderInput = Pick<
  BulkEmailCampaignInput,
  "subject" | "preheader" | "headline" | "body" | "imageUrl" | "ctaLabel" | "ctaUrl"
> & {
  clientName: string;
  clientEmail: string;
  salonName: string;
  salonAddress?: string | null;
};

export type BulkEmailRenderResult = {
  subject: string;
  html: string;
  text: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bodyHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 16px;">${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

export function renderBulkEmailCampaign(input: BulkEmailRenderInput): BulkEmailRenderResult {
  const content = bulkEmailCampaignInputSchema.pick({
    subject: true,
    preheader: true,
    headline: true,
    body: true,
    imageUrl: true,
    ctaLabel: true,
    ctaUrl: true,
  }).parse(input);
  const clientName = input.clientName.trim() || "Guest";
  const hiddenPreheader = content.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(content.preheader)}</div>`
    : "";
  const image = content.imageUrl
    ? `<img src="${escapeHtml(content.imageUrl)}" alt="" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;" />`
    : "";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f2ec;color:#171717;font-family:Arial,sans-serif;">
${hiddenPreheader}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f2ec;padding:24px 12px;"><tr><td align="center">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;">
    <tr><td style="background:#0b0c10;padding:24px 28px;text-align:center;">${buildEmailBrandHeader({ salonName: input.salonName, subtitle: "A PERSONAL NOTE FOR YOU" })}</td></tr>
    ${image ? `<tr><td>${image}</td></tr>` : ""}
    <tr><td style="padding:30px 28px 10px;">
      <p style="margin:0 0 12px;font-size:16px;line-height:1.6;">Hi ${escapeHtml(clientName)},</p>
      <h1 style="margin:0 0 18px;font-size:28px;line-height:1.2;color:#171717;">${escapeHtml(content.headline)}</h1>
      <div style="font-size:16px;line-height:1.65;color:#333333;">${bodyHtml(content.body)}</div>
      <div style="padding:8px 0 22px;text-align:center;"><a href="${escapeHtml(content.ctaUrl)}" style="display:inline-block;background:#d4af37;color:#111111;text-decoration:none;font-weight:700;padding:14px 24px;border-radius:999px;">${escapeHtml(content.ctaLabel)}</a></div>
      ${complianceFooterHtml({ email: input.clientEmail, salonName: input.salonName, salonAddress: input.salonAddress, lang: "en", context: "marketing" })}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  const text = [
    `Hi ${clientName},`,
    "",
    content.headline,
    "",
    content.body,
    "",
    `${content.ctaLabel}: ${content.ctaUrl}`,
    "",
    `You're receiving an optional update from ${input.salonName}.`,
    input.salonAddress ? `${input.salonName} · ${input.salonAddress}` : input.salonName,
    "Use the unsubscribe link in this email to stop receiving marketing messages.",
  ].join("\n");

  return { subject: content.subject, html, text };
}
