import "server-only";

import { formatCurrencyOrZero } from "@/shared/lib/currencyFormat";
import { complianceFooterHtml, listUnsubscribeHeaders } from "@/shared/lib/emailCompliance";
import {
  parseGroupBookingPricingQuote,
  type GroupBookingPricingMember,
  type GroupBookingPricingQuote,
} from "@/shared/booking/groupBookingPricing";
import {
  type NotificationClaim,
  type NotificationFinalStatus,
} from "@/shared/lib/notificationLog";
import { getResendFrom } from "@/shared/lib/resend";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  buildEmailBrandHeader,
  normalizeEmailLocale,
  normalizeEmailLogoUrl,
  type EmailLocale,
} from "@/shared/booking/emailBranding";
import { deliverBookingConfirmation } from "@/shared/booking/bookingConfirmationRetryDelivery";

export type GroupConfirmationMember = {
  bookingId: string;
  clientName: string;
  serviceName: string;
  staffName: string;
  pricing: GroupBookingPricingMember;
};

export type AuthoritativeGroupConfirmationReceipt = {
  organizerBookingId: string;
  organizerName: string;
  organizerEmail: string;
  organizerLocale?: EmailLocale | null;
  groupId: string;
  shopSlug: string;
  salonId: string;
  salonName: string;
  salonLogoUrl?: string | null;
  salonTimezone: string;
  salonAddress: string | null;
  salonReplyEmail: string | null;
  pricing: GroupBookingPricingQuote;
  members: GroupConfirmationMember[];
};

export type GroupConfirmationEmailResult = {
  outcome: "sent" | "failed" | "unknown" | "suppressed";
  reason: string;
  providerId: string | null;
  claimFinalized: boolean;
};

type ProviderResponse = {
  data?: { id?: string | null } | null;
  error?: { message?: unknown } | null;
};

type ProviderPayload = {
  from: string;
  to: string;
  subject: string;
  html: string;
  headers: Record<string, string>;
  replyTo?: string;
};

type GroupConfirmationProvider = {
  send(payload: ProviderPayload): Promise<ProviderResponse>;
};

export type GroupConfirmationEmailDeps = {
  loadReceipt(params: {
    organizerBookingId: string;
    salonId: string;
    shopSlug: string;
  }): Promise<AuthoritativeGroupConfirmationReceipt | null>;
  claim(params: {
    bookingId: string;
    salonId: string;
    notificationType: "booking_confirmation";
    channel: "email";
    bodyPreview: string;
  }): Promise<NotificationClaim>;
  provider(): GroupConfirmationProvider | null;
  finalize(
    claimId: string,
    params: {
      status: NotificationFinalStatus;
      messageSid: string | null;
      errorMessage: string | null;
    },
  ): Promise<boolean>;
  from(): string;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonblank(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Every persisted group row must name the same canonical pricing material as
 * the organizer snapshot; a single stale/tampered row suppresses the receipt. */
export function groupConfirmationFingerprintsMatch(
  expected: string,
  persistedValues: unknown[],
): boolean {
  return persistedValues.length > 0 && persistedValues.every((value) => value === expected);
}

function sameInstant(left: string, right: unknown): boolean {
  return typeof right === "string" && Date.parse(left) === Date.parse(right);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateTime(value: string, timezone: string, locale: EmailLocale): string {
  try {
    return new Intl.DateTimeFormat(locale === "vi" ? "vi-VN" : "en-CA", {
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function money(cents: number, currency: string): string {
  return escapeHtml(formatCurrencyOrZero(cents, currency));
}

function rateLabel(value: number): string {
  return `${(value * 100).toFixed(3).replace(/\.?0+$/, "")}%`;
}

export function buildGroupBookingConfirmationSubject(
  salonName: string,
  locale: EmailLocale | null | undefined,
): string {
  return normalizeEmailLocale(locale) === "vi"
    ? `Lịch hẹn nhóm đã xác nhận — ${salonName}`
    : `Group booking confirmed — ${salonName}`;
}

/** Pure authoritative receipt renderer. Zero/free totals and every discount and
 * tax line are deliberately rendered rather than treated as missing values. */
export function buildGroupBookingConfirmationHtml(
  receipt: AuthoritativeGroupConfirmationReceipt,
): string {
  const locale = normalizeEmailLocale(receipt.organizerLocale);
  const copy = locale === "vi"
    ? {
        subtitle: "Lịch hẹn nhóm đã xác nhận", heading: "Lịch hẹn nhóm của bạn đã được xác nhận",
        hello: "Chào", party: "nhóm", at: "tại", confirmed: "đã được xác nhận.",
        member: "Thành viên", with: "với", addon: "Dịch vụ thêm", service: "Dịch vụ",
        subtotal: "Tạm tính", memberTotal: "Tổng thành viên", receipt: "Hoá đơn nhóm",
        original: "Dịch vụ ban đầu", addons: "Dịch vụ thêm", total: "Tổng nhóm",
      }
    : {
        subtitle: "Group Booking Confirmed", heading: "Your group booking is confirmed",
        hello: "Hi", party: "your party of", at: "at", confirmed: "is confirmed.",
        member: "Member", with: "with", addon: "Add-on", service: "Service",
        subtotal: "Subtotal", memberTotal: "Member total", receipt: "Group receipt",
        original: "Original services", addons: "Add-ons", total: "Group total",
      };
  const { pricing } = receipt;
  const aggregateAddonPreVoucherCents = pricing.memberQuotes.reduce(
    (total, member) => total + member.addonPreVoucherCents,
    0,
  );
  const memberBlocks = receipt.members.map((member) => {
    const p = member.pricing;
    const addonRows = p.addonLines.map((addon) => `
      <tr><td style="padding:4px 0 4px 14px;color:#666;">${copy.addon} · ${escapeHtml(addon.name)}</td><td style="padding:4px 0;text-align:right;">${money(addon.priceCents, pricing.currency)}</td></tr>`).join("");
    const discountRows = p.discountLines.map((line) => `
      <tr><td style="padding:4px 0;color:#666;">${escapeHtml(line.label)}</td><td style="padding:4px 0;text-align:right;">−${money(line.amountCents, pricing.currency)}</td></tr>`).join("");
    const taxRows = p.taxBreakdown.map((line) => `
      <tr><td style="padding:4px 0;color:#666;">${escapeHtml(line.name)} (${rateLabel(line.rate)})</td><td style="padding:4px 0;text-align:right;">+${money(line.amountCents, pricing.currency)}</td></tr>`).join("");
    return `<div data-member-index="${p.memberIndex}" style="margin:0 0 14px;padding:14px;border:1px solid #e8e8e8;border-radius:8px;">
      <p style="margin:0 0 8px;font-weight:700;">${copy.member} ${p.memberIndex + 1}: ${escapeHtml(member.clientName)}</p>
      <p style="margin:0 0 4px;color:#444;">${escapeHtml(member.serviceName)} ${copy.with} ${escapeHtml(member.staffName)}</p>
      <p style="margin:0 0 8px;color:#666;font-size:13px;">${escapeHtml(formatDateTime(p.startTimeUtc, receipt.salonTimezone, locale))}</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;">
        <tr><td style="padding:4px 0;color:#666;">${copy.service}</td><td style="padding:4px 0;text-align:right;">${money(p.serviceOriginalCents, pricing.currency)}</td></tr>
        ${addonRows}${discountRows}
        <tr><td style="padding:4px 0;color:#666;">${copy.subtotal}</td><td style="padding:4px 0;text-align:right;">${money(p.subtotalCents, pricing.currency)}</td></tr>
        ${taxRows}
        <tr><td style="padding:6px 0 0;font-weight:700;">${copy.memberTotal}</td><td style="padding:6px 0 0;text-align:right;font-weight:700;">${money(p.totalCents, pricing.currency)}</td></tr>
      </table>
    </div>`;
  }).join("");

  const discountRows = pricing.discountLines.map((line) => `
    <tr><td style="padding:5px 0;color:#666;">${escapeHtml(line.label)}</td><td style="padding:5px 0;text-align:right;">−${money(line.amountCents, pricing.currency)}</td></tr>`).join("");
  const taxRows = pricing.taxBreakdown.map((line) => `
    <tr><td style="padding:5px 0;color:#666;">${escapeHtml(line.name)} (${rateLabel(line.rate)})</td><td style="padding:5px 0;text-align:right;">+${money(line.amountCents, pricing.currency)}</td></tr>`).join("");

  return `<!doctype html><html lang="${locale}"><body style="margin:0;padding:24px;background:#f5f5f5;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111;">
    <main style="max-width:620px;margin:auto;background:#fff;padding:28px;border-radius:12px;">
      <div style="padding:16px;background:#0B0C10;text-align:center;border-radius:8px;">
        ${buildEmailBrandHeader({ salonName: receipt.salonName, logoUrl: receipt.salonLogoUrl, subtitle: copy.subtitle })}
      </div>
      <h1 style="margin:0 0 8px;font-size:22px;">${copy.heading}</h1>
      <p style="margin:0 0 22px;color:#555;">${copy.hello} ${escapeHtml(receipt.organizerName)}, ${copy.party} ${pricing.groupSize} ${copy.at} <strong>${escapeHtml(receipt.salonName)}</strong> ${copy.confirmed}</p>
      ${memberBlocks}
      <section style="margin-top:20px;padding:16px;background:#fafafa;border-radius:8px;">
        <h2 style="margin:0 0 8px;font-size:16px;">${copy.receipt}</h2>
        <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
          <tr><td style="padding:5px 0;color:#666;">${copy.original}</td><td style="padding:5px 0;text-align:right;">${money(pricing.serviceOriginalCents, pricing.currency)}</td></tr>
          <tr><td style="padding:5px 0;color:#666;">${copy.addons}</td><td style="padding:5px 0;text-align:right;">${money(aggregateAddonPreVoucherCents, pricing.currency)}</td></tr>
          ${discountRows}
          <tr><td style="padding:5px 0;color:#666;">${copy.subtotal}</td><td style="padding:5px 0;text-align:right;">${money(pricing.subtotalCents, pricing.currency)}</td></tr>
          ${taxRows}
          <tr><td style="padding:8px 0 0;font-weight:800;">${copy.total}</td><td style="padding:8px 0 0;text-align:right;font-weight:800;">${money(pricing.totalCents, pricing.currency)}</td></tr>
        </table>
      </section>
    </main>
  </body></html>`;
}

/** Load and reconcile the exact persisted canonical group snapshot. No caller
 * supplied money or display row crosses this boundary. */
export async function loadAuthoritativeGroupConfirmationReceipt(params: {
  organizerBookingId: string;
  salonId: string;
  shopSlug: string;
}): Promise<AuthoritativeGroupConfirmationReceipt | null> {
  const db = createServiceRoleClient();
  const { data: organizerRaw, error: organizerError } = await db
    .from("bookings" as never)
    .select("id, salon_id, group_id, status, is_group_organizer, client_name, client_email, client_locale, public_booking_pricing_fingerprint, public_booking_pricing_snapshot" as never)
    .eq("id" as never, params.organizerBookingId)
    .eq("salon_id" as never, params.salonId)
    .maybeSingle();
  if (organizerError || !record(organizerRaw)) return null;
  const organizer = organizerRaw as Record<string, unknown>;
  const snapshot = organizer.public_booking_pricing_snapshot;
  if (!record(snapshot)) return null;
  const pricing = parseGroupBookingPricingQuote(snapshot);
  const groupId = nonblank(snapshot.group_id);
  const bookingIds = Array.isArray(snapshot.booking_ids)
    ? snapshot.booking_ids.map(nonblank)
    : [];
  if (
    !pricing ||
    pricing.salonId !== params.salonId ||
    organizer.id !== params.organizerBookingId ||
    organizer.salon_id !== params.salonId ||
    organizer.status !== "confirmed" ||
    organizer.is_group_organizer !== true ||
    organizer.group_id !== groupId ||
    !groupConfirmationFingerprintsMatch(pricing.pricingFingerprint, [
      organizer.public_booking_pricing_fingerprint,
    ]) ||
    !groupId ||
    bookingIds.some((id) => !id) ||
    new Set(bookingIds).size !== bookingIds.length ||
    bookingIds[0] !== params.organizerBookingId ||
    bookingIds.length !== pricing.groupSize
  ) return null;
  const exactBookingIds = bookingIds as string[];
  const organizerEmail = nonblank(organizer.client_email)?.toLowerCase();
  const organizerName = nonblank(organizer.client_name);
  if (!organizerEmail || !organizerName) return null;

  const [salonResult, bookingsResult] = await Promise.all([
    db.from("salons" as never)
      .select("id, slug, name, timezone, address, email, logo_url" as never)
      .eq("id" as never, params.salonId)
      .eq("slug" as never, params.shopSlug)
      .maybeSingle(),
    db.from("bookings" as never)
      .select("id, salon_id, group_id, status, client_name, service_id, staff_id, start_time_utc, end_time_utc, public_booking_pricing_fingerprint" as never)
      .eq("salon_id" as never, params.salonId)
      .in("id" as never, exactBookingIds),
  ]);
  if (salonResult.error || bookingsResult.error || !record(salonResult.data) || !Array.isArray(bookingsResult.data)) return null;
  const salon = salonResult.data as Record<string, unknown>;
  const rows = bookingsResult.data as unknown as Record<string, unknown>[];
  if (
    salon.id !== params.salonId ||
    salon.slug !== params.shopSlug ||
    rows.length !== exactBookingIds.length
  ) return null;
  if (!groupConfirmationFingerprintsMatch(
    pricing.pricingFingerprint,
    rows.map((row) => row.public_booking_pricing_fingerprint),
  )) return null;
  const byId = new Map(rows.map((row) => [nonblank(row.id), row]));
  const orderedRows: Record<string, unknown>[] = [];
  for (const [index, bookingId] of exactBookingIds.entries()) {
    const row = byId.get(bookingId);
    const member = pricing.memberQuotes[index];
    if (
      !row ||
      row.salon_id !== params.salonId ||
      row.group_id !== groupId ||
      row.status !== "confirmed" ||
      row.service_id !== member.serviceId ||
      row.staff_id !== member.staffId ||
      !sameInstant(member.startTimeUtc, row.start_time_utc) ||
      !sameInstant(member.endTimeUtc, row.end_time_utc) ||
      !nonblank(row.client_name)
    ) return null;
    orderedRows.push(row);
  }
  const serviceIds = [...new Set(pricing.memberQuotes.map((member) => member.serviceId))];
  const staffIds = [...new Set(pricing.memberQuotes.map((member) => member.staffId))];
  const [servicesResult, staffResult] = await Promise.all([
    db.from("services" as never).select("id, name" as never).eq("salon_id" as never, params.salonId).in("id" as never, serviceIds),
    db.from("staff" as never).select("id, name" as never).eq("salon_id" as never, params.salonId).in("id" as never, staffIds),
  ]);
  if (servicesResult.error || staffResult.error || !Array.isArray(servicesResult.data) || !Array.isArray(staffResult.data)) return null;
  const serviceNames = new Map((servicesResult.data as unknown as Record<string, unknown>[]).map((row) => [nonblank(row.id), nonblank(row.name)]));
  const staffNames = new Map((staffResult.data as unknown as Record<string, unknown>[]).map((row) => [nonblank(row.id), nonblank(row.name)]));
  const members: GroupConfirmationMember[] = [];
  for (const [index, row] of orderedRows.entries()) {
    const memberPricing = pricing.memberQuotes[index];
    const serviceName = serviceNames.get(memberPricing.serviceId);
    const staffName = staffNames.get(memberPricing.staffId);
    const clientName = nonblank(row.client_name);
    if (!serviceName || !staffName || !clientName) return null;
    members.push({ bookingId: exactBookingIds[index], clientName, serviceName, staffName, pricing: memberPricing });
  }
  const salonName = nonblank(salon.name);
  const salonTimezone = nonblank(salon.timezone);
  if (!salonName || !salonTimezone) return null;
  return {
    organizerBookingId: params.organizerBookingId,
    organizerName,
    organizerEmail,
    organizerLocale: normalizeEmailLocale(organizer.client_locale),
    groupId,
    shopSlug: params.shopSlug,
    salonId: params.salonId,
    salonName,
    salonLogoUrl: normalizeEmailLogoUrl(salon.logo_url),
    salonTimezone,
    salonAddress: nonblank(salon.address),
    salonReplyEmail: nonblank(salon.email)?.toLowerCase() ?? null,
    pricing,
    members,
  };
}

async function finalizeTwice(
  deps: GroupConfirmationEmailDeps,
  claimId: string,
  completion: {
    status: NotificationFinalStatus;
    messageSid: string | null;
    errorMessage: string | null;
  },
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (await deps.finalize(claimId, completion)) return true;
    } catch {
      // Retry the same exact-row completion once. Never cross the provider
      // boundary again: an exception here concerns durable bookkeeping only.
    }
  }
  return false;
}

/** Sole immediate group-confirmation producer. Callers provide identity only;
 * all pricing, contact, membership and display data is reloaded server-side. */
export async function sendGroupBookingConfirmationEmail(
  params: { organizerBookingId: string; salonId: string; shopSlug: string },
  deps?: GroupConfirmationEmailDeps,
): Promise<GroupConfirmationEmailResult> {
  if (!nonblank(params.organizerBookingId) || !nonblank(params.salonId) || !nonblank(params.shopSlug)) {
    return { outcome: "suppressed", reason: "invalid_identity", providerId: null, claimFinalized: false };
  }
  let receipt: AuthoritativeGroupConfirmationReceipt | null;
  try {
    receipt = await (deps?.loadReceipt ?? loadAuthoritativeGroupConfirmationReceipt)(params);
  } catch {
    receipt = null;
  }
  if (!receipt) {
    return { outcome: "suppressed", reason: "authoritative_receipt_unavailable", providerId: null, claimFinalized: false };
  }

  const html = buildGroupBookingConfirmationHtml(receipt).replace(
    "</body>",
    `${complianceFooterHtml({
      email: receipt.organizerEmail,
      salonName: receipt.salonName,
      salonAddress: receipt.salonAddress,
      lang: normalizeEmailLocale(receipt.organizerLocale),
    })}</body>`,
  );

  if (!deps) {
    const replyTo = receipt.salonReplyEmail && receipt.salonReplyEmail.includes("@") &&
      !/[\u0000-\u001f\u007f]/.test(receipt.salonReplyEmail)
      ? receipt.salonReplyEmail
      : null;
    const result = await deliverBookingConfirmation({
      bookingId: receipt.organizerBookingId,
      salonId: receipt.salonId,
      envelope: {
        v: 1,
        channel: "email",
        salonId: receipt.salonId,
        from: getResendFrom(),
        to: receipt.organizerEmail,
        subject: buildGroupBookingConfirmationSubject(
          receipt.salonName,
          receipt.organizerLocale,
        ),
        html,
        headers: listUnsubscribeHeaders(receipt.organizerEmail),
        replyTo,
        attachments: [],
      },
    });
    return {
      outcome: result.outcome === "accepted"
        ? "sent"
        : result.outcome === "rejected"
          ? "failed"
          : result.outcome,
      reason: result.reason,
      providerId: result.providerMessageId,
      claimFinalized: result.finalized,
    };
  }

  let provider: GroupConfirmationProvider | null;
  try {
    provider = deps.provider();
  } catch {
    provider = null;
  }
  if (!provider) {
    return { outcome: "suppressed", reason: "provider_unavailable", providerId: null, claimFinalized: false };
  }
  let claim: NotificationClaim;
  try {
    claim = await deps.claim({
      bookingId: receipt.organizerBookingId,
      salonId: receipt.salonId,
      notificationType: "booking_confirmation",
      channel: "email",
      bodyPreview: `Group confirmation → ${receipt.organizerEmail}`,
    });
  } catch {
    claim = "unguarded";
  }
  if (claim === "skip") {
    // A unique-claim collision proves only that another durable row exists.
    // Without loading that row we cannot truthfully distinguish sent from
    // sending, unknown, suppressed, or definitively failed. Never reopen the
    // provider boundary here, and do not overstate durable completion.
    return {
      outcome: "suppressed",
      reason: "duplicate_or_in_progress",
      providerId: null,
      claimFinalized: false,
    };
  }
  if (claim === "unguarded") {
    return { outcome: "suppressed", reason: "claim_unavailable", providerId: null, claimFinalized: false };
  }

  let status: NotificationFinalStatus = "unknown";
  let providerId: string | null = null;
  let errorMessage = "provider_not_attempted";
  try {
    const response = await provider.send({
      from: deps.from(),
      to: receipt.organizerEmail,
      subject: buildGroupBookingConfirmationSubject(
        receipt.salonName,
        receipt.organizerLocale,
      ),
      html,
      headers: listUnsubscribeHeaders(receipt.organizerEmail),
      ...(receipt.salonReplyEmail ? { replyTo: receipt.salonReplyEmail } : {}),
    });
    const receiptId = nonblank(response.data?.id);
    if (response.error) {
      status = "failed";
      errorMessage = nonblank(response.error.message) ?? "provider_error";
    } else if (receiptId) {
      status = "sent";
      providerId = receiptId;
      errorMessage = "";
    } else {
      status = "unknown";
      errorMessage = "provider_missing_receipt";
    }
  } catch {
    status = "unknown";
    errorMessage = "provider_exception";
  }
  const claimFinalized = await finalizeTwice(deps, claim, {
    status,
    messageSid: providerId,
    errorMessage: errorMessage || null,
  });
  if (!claimFinalized) {
    console.error("[sendGroupBookingConfirmationEmail] claim completion not persisted", {
      claimId: claim,
      status,
      hasProviderReceipt: Boolean(providerId),
    });
  }
  return {
    outcome: status,
    reason: errorMessage || "provider_accepted",
    providerId,
    claimFinalized,
  };
}
