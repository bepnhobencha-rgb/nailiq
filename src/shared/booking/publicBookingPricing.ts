import {
  isSupportedCurrency,
  type Currency,
} from "@/shared/lib/currencyFormat";

export type PublicBookingTaxLine = {
  name: string;
  rate: number;
  amountCents: number;
};

export type PublicBookingAddonLine = {
  serviceId: string;
  name: string;
  priceCents: number;
  durationMinutes: number;
  bufferMinutes: number;
  addonTiming: string | null;
};

export type PublicBookingDiscountLine = {
  kind: "promotion" | "email_incentive" | "voucher";
  label: string;
  amountCents: number;
};

/** One server-authoritative receipt. The same shape drives confirm, create,
 * success, email, and risk decisions; catalog prices are never substituted. */
export type PublicBookingPricingQuote = {
  pricingFingerprint: string;
  salonId: string;
  serviceId: string;
  resolvedStaffId: string;
  resolvedStaffName: string;
  startTimeUtc: string;
  endTimeUtc: string;
  comboId: string | null;
  voucherId: string | null;
  voucherCode: string | null;
  currency: Currency;
  serviceOriginalCents: number;
  /** Main service after promotion/email, before a subtotal voucher. */
  serviceNetCents: number;
  /** Main service portion persisted after the subtotal voucher is allocated. */
  serviceFinalCents: number;
  addonPreVoucherCents: number;
  /** Add-on portion persisted after the subtotal voucher is allocated. */
  addonCents: number;
  promoId: string | null;
  promoName: string | null;
  promoDiscountCents: number;
  emailDiscountCents: number;
  voucherDiscountCents: number;
  preVoucherSubtotalCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  taxBreakdown: PublicBookingTaxLine[];
  addonLines: PublicBookingAddonLine[];
  discountLines: PublicBookingDiscountLine[];
};

export type PublicBookingQuoteRequest = {
  salonId: string;
  serviceId: string;
  resolvedStaffId: string;
  resolvedStaffName?: string;
  startTimeUtc: string;
  endTimeUtc: string;
  addonServiceIds: string[];
  comboId?: string | null;
  voucherCode?: string | null;
  clientPhone: string;
  clientEmail?: string | null;
  applyEmailDiscount: boolean;
};

export class PublicBookingQuoteError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "PublicBookingQuoteError";
  }
}

export type PublicBookingPricingKeyInput = Pick<
  PublicBookingQuoteRequest,
  | "serviceId"
  | "addonServiceIds"
  | "comboId"
  | "voucherCode"
  | "clientPhone"
  | "clientEmail"
  | "applyEmailDiscount"
> & {
  shopSlug: string;
  staffId: string;
  bookingDateYmd: string;
  timeSlot: string;
};

/** Every browser input that can change resolver material is represented here.
 * A different key makes the prior quote unreadable immediately. */
export function buildPublicBookingPricingQuoteKey(
  input: PublicBookingPricingKeyInput,
): string {
  return JSON.stringify({
    shopSlug: input.shopSlug,
    serviceId: input.serviceId,
    staffId: input.staffId,
    day: input.bookingDateYmd,
    time: input.timeSlot,
    phone: input.clientPhone,
    email: input.clientEmail ?? null,
    addons: input.addonServiceIds,
    combo: input.comboId ?? null,
    voucher: input.voucherCode?.trim().toUpperCase() || null,
    emailDiscount: input.applyEmailDiscount,
  });
}

type ParseContext = {
  resolvedStaffId: string;
  resolvedStaffName?: string | null;
  voucherCode?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function nullableString(value: unknown): string | null {
  return value == null ? null : requiredString(value);
}

function cents(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function finiteRate(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

/** Parse and reconcile a flat quote returned by the database. Any malformed or
 * arithmetically inconsistent snapshot fails closed instead of showing $0. */
export function parsePublicBookingPricingQuote(
  value: unknown,
  context: ParseContext,
): PublicBookingPricingQuote | null {
  if (!isRecord(value) || value.success !== true) return null;

  const pricingFingerprint = requiredString(value.pricing_fingerprint);
  const salonId = requiredString(value.salon_id);
  const serviceId = requiredString(value.service_id);
  const startTimeUtc = requiredString(value.start_time_utc);
  const endTimeUtc = requiredString(value.end_time_utc);
  const resolvedStaffId = requiredString(context.resolvedStaffId);
  const currencyRaw = requiredString(value.currency);
  if (
    !pricingFingerprint ||
    !/^[a-f0-9]{64}$/i.test(pricingFingerprint) ||
    !salonId ||
    !serviceId ||
    !startTimeUtc ||
    !endTimeUtc ||
    !resolvedStaffId ||
    !currencyRaw ||
    !isSupportedCurrency(currencyRaw) ||
    !Number.isFinite(Date.parse(startTimeUtc)) ||
    !Number.isFinite(Date.parse(endTimeUtc))
  ) {
    return null;
  }

  const serviceOriginalCents = cents(value.original_price_cents);
  const serviceNetCents = cents(value.service_pre_voucher_cents);
  const serviceFinalCents = cents(value.price_cents);
  const addonPreVoucherCents = cents(value.addon_pre_voucher_cents);
  const addonCents = cents(value.addon_price_cents);
  const promoDiscountCents = cents(value.promo_discount_cents);
  const emailDiscountCents = cents(value.email_discount_cents);
  const voucherDiscountCents = cents(value.voucher_discount_cents);
  const preVoucherSubtotalCents = cents(value.pre_voucher_subtotal_cents);
  const subtotalCents = cents(value.subtotal_cents);
  const taxCents = cents(value.tax_cents);
  const totalCents = cents(value.total_cents);
  if (
    serviceOriginalCents == null ||
    serviceNetCents == null ||
    serviceFinalCents == null ||
    addonPreVoucherCents == null ||
    addonCents == null ||
    promoDiscountCents == null ||
    emailDiscountCents == null ||
    voucherDiscountCents == null ||
    preVoucherSubtotalCents == null ||
    subtotalCents == null ||
    taxCents == null ||
    totalCents == null
  ) {
    return null;
  }

  if (
    serviceOriginalCents - promoDiscountCents - emailDiscountCents !==
      serviceNetCents ||
    serviceNetCents + addonPreVoucherCents !== preVoucherSubtotalCents ||
    serviceFinalCents + addonCents !== subtotalCents ||
    preVoucherSubtotalCents - voucherDiscountCents !== subtotalCents ||
    subtotalCents + taxCents !== totalCents
  ) {
    return null;
  }

  if (!Array.isArray(value.tax_breakdown) || !Array.isArray(value.addon_lines)) {
    return null;
  }
  const taxBreakdown: PublicBookingTaxLine[] = [];
  for (const raw of value.tax_breakdown) {
    if (!isRecord(raw)) return null;
    const name = requiredString(raw.name);
    const rate = finiteRate(raw.rate);
    const amountCents = cents(raw.amount_cents);
    if (!name || rate == null || amountCents == null) return null;
    taxBreakdown.push({ name, rate, amountCents });
  }
  if (taxBreakdown.reduce((sum, line) => sum + line.amountCents, 0) !== taxCents) {
    return null;
  }

  const addonLines: PublicBookingAddonLine[] = [];
  for (const raw of value.addon_lines) {
    if (!isRecord(raw)) return null;
    const addonServiceId = requiredString(raw.service_id);
    const name = requiredString(raw.name);
    const priceCents = cents(raw.price_cents);
    const durationMinutes = cents(raw.duration_minutes);
    const bufferMinutes = cents(raw.buffer_minutes);
    if (
      !addonServiceId ||
      !name ||
      priceCents == null ||
      durationMinutes == null ||
      bufferMinutes == null
    ) {
      return null;
    }
    addonLines.push({
      serviceId: addonServiceId,
      name,
      priceCents,
      durationMinutes,
      bufferMinutes,
      addonTiming: nullableString(raw.addon_timing),
    });
  }
  if (addonLines.reduce((sum, line) => sum + line.priceCents, 0) !== addonPreVoucherCents) {
    return null;
  }

  const promoName = nullableString(value.promo_name);
  const voucherCode = nullableString(context.voucherCode);
  const discountLines: PublicBookingDiscountLine[] = [
    ...(promoDiscountCents > 0
      ? [
          {
            kind: "promotion" as const,
            label: promoName ?? "Promotion",
            amountCents: promoDiscountCents,
          },
        ]
      : []),
    ...(emailDiscountCents > 0
      ? [
          {
            kind: "email_incentive" as const,
            label: "Email incentive",
            amountCents: emailDiscountCents,
          },
        ]
      : []),
    ...(voucherDiscountCents > 0
      ? [
          {
            kind: "voucher" as const,
            label: voucherCode ? `Voucher ${voucherCode}` : "Voucher",
            amountCents: voucherDiscountCents,
          },
        ]
      : []),
  ];

  return {
    pricingFingerprint,
    salonId,
    serviceId,
    resolvedStaffId,
    resolvedStaffName: context.resolvedStaffName?.trim() ?? "",
    startTimeUtc,
    endTimeUtc,
    comboId: nullableString(value.combo_id),
    voucherId: nullableString(value.voucher_id),
    voucherCode,
    currency: currencyRaw,
    serviceOriginalCents,
    serviceNetCents,
    serviceFinalCents,
    addonPreVoucherCents,
    addonCents,
    promoId: nullableString(value.promo_id),
    promoName,
    promoDiscountCents,
    emailDiscountCents,
    voucherDiscountCents,
    preVoucherSubtotalCents,
    subtotalCents,
    taxCents,
    totalCents,
    taxBreakdown,
    addonLines,
    discountLines,
  };
}

function isNormalizedQuote(value: unknown): value is PublicBookingPricingQuote {
  if (!isRecord(value)) return false;
  const q = value as Partial<PublicBookingPricingQuote>;
  return (
    typeof q.pricingFingerprint === "string" &&
    /^[a-f0-9]{64}$/i.test(q.pricingFingerprint) &&
    typeof q.salonId === "string" &&
    typeof q.serviceId === "string" &&
    typeof q.resolvedStaffId === "string" &&
    typeof q.startTimeUtc === "string" &&
    typeof q.endTimeUtc === "string" &&
    typeof q.currency === "string" &&
    isSupportedCurrency(q.currency) &&
    cents(q.serviceOriginalCents) !== null &&
    cents(q.serviceNetCents) !== null &&
    cents(q.serviceFinalCents) !== null &&
    cents(q.addonPreVoucherCents) !== null &&
    cents(q.addonCents) !== null &&
    cents(q.preVoucherSubtotalCents) !== null &&
    cents(q.subtotalCents) !== null &&
    cents(q.taxCents) !== null &&
    cents(q.totalCents) !== null &&
    q.serviceNetCents! + q.addonPreVoucherCents! === q.preVoucherSubtotalCents &&
    q.serviceFinalCents! + q.addonCents! === q.subtotalCents &&
    q.subtotalCents! + q.taxCents! === q.totalCents &&
    Array.isArray(q.taxBreakdown) &&
    Array.isArray(q.addonLines) &&
    Array.isArray(q.discountLines)
  );
}

/** Browser entry point. The quote route uses the service-role-only resolver;
 * the browser never receives a privileged database credential. */
export async function requestPublicBookingQuote(
  input: PublicBookingQuoteRequest,
): Promise<PublicBookingPricingQuote> {
  const response = await fetch("/api/booking/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (
    !response.ok ||
    !isRecord(body) ||
    body.ok !== true ||
    !isNormalizedQuote(body.quote)
  ) {
    const code = isRecord(body) && typeof body.code === "string"
      ? body.code
      : "quote_unavailable";
    throw new PublicBookingQuoteError(code);
  }
  return body.quote;
}
