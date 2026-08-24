import {
  isSupportedCurrency,
  type Currency,
} from "@/shared/lib/currencyFormat";
import type {
  PublicBookingAddonLine,
  PublicBookingDiscountLine,
  PublicBookingTaxLine,
} from "@/shared/booking/publicBookingPricing";

export type GroupBookingPricingMember = {
  memberIndex: number;
  serviceId: string;
  staffId: string;
  startTimeUtc: string;
  endTimeUtc: string;
  addonServiceIds: string[];
  addonLines: PublicBookingAddonLine[];
  firstAddonId: string | null;
  trailingBufferMinutes: number;
  promoId: string | null;
  promoName: string | null;
  serviceOriginalCents: number;
  serviceNetCents: number;
  serviceFinalCents: number;
  addonPreVoucherCents: number;
  addonCents: number;
  promoDiscountCents: number;
  emailDiscountCents: number;
  voucherDiscountCents: number;
  preVoucherSubtotalCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  taxBreakdown: PublicBookingTaxLine[];
  discountLines: PublicBookingDiscountLine[];
};

export type GroupBookingPricingQuote = {
  pricingFingerprint: string;
  salonId: string;
  groupSize: number;
  currency: Currency;
  voucherId: string | null;
  voucherCode: string | null;
  serviceOriginalCents: number;
  promoDiscountCents: number;
  emailDiscountCents: number;
  voucherDiscountCents: number;
  preVoucherSubtotalCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  taxBreakdown: PublicBookingTaxLine[];
  memberQuotes: GroupBookingPricingMember[];
  discountLines: PublicBookingDiscountLine[];
};

export type GroupBookingPricingRequestMember = {
  serviceId: string;
  staffId: string;
  startTimeUtc: string;
  endTimeUtc: string;
  addonServiceIds: string[];
  clientName?: string;
  clientPhone?: string | null;
  clientEmail?: string | null;
  clientNotes?: string | null;
  staffRequestedByClient?: boolean;
  waveNumber?: number;
  seatTogether?: boolean;
  clientLocale?: "en" | "vi" | null;
  resourceId?: string | null;
};

export type GroupBookingPricingRequest = {
  salonId: string;
  bookings: GroupBookingPricingRequestMember[];
  voucherCode?: string | null;
  /** Legacy caller mirrors. The server ignores these and derives organizer
   * identity exclusively from bookings[0]. */
  clientPhone?: string;
  clientEmail?: string | null;
  applyEmailDiscount: boolean;
};

/** PostgreSQL and browsers may serialize the same UTC instant differently
 * (`+00:00` vs `Z`). Security binding cares about the instant, not spelling. */
export function groupBookingInstantMatches(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableText(value: unknown): string | null {
  return value == null ? null : text(value);
}

function cents(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

function rate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function parseTaxLines(value: unknown): PublicBookingTaxLine[] | null {
  if (!Array.isArray(value)) return null;
  const lines: PublicBookingTaxLine[] = [];
  for (const raw of value) {
    if (!record(raw)) return null;
    const name = text(raw.name);
    const taxRate = rate(raw.rate);
    const amountCents = cents(raw.amount_cents);
    if (!name || taxRate == null || amountCents == null) return null;
    lines.push({ name, rate: taxRate, amountCents });
  }
  return lines;
}

function parseAddonLines(value: unknown): PublicBookingAddonLine[] | null {
  if (!Array.isArray(value)) return null;
  const lines: PublicBookingAddonLine[] = [];
  for (const raw of value) {
    if (!record(raw)) return null;
    const serviceId = text(raw.service_id);
    const name = text(raw.name);
    const priceCents = cents(raw.price_cents);
    const durationMinutes = cents(raw.duration_minutes);
    const bufferMinutes = cents(raw.buffer_minutes);
    if (raw.addon_timing != null && !text(raw.addon_timing)) return null;
    if (
      !serviceId ||
      !name ||
      priceCents == null ||
      durationMinutes == null ||
      bufferMinutes == null
    ) return null;
    lines.push({
      serviceId,
      name,
      priceCents,
      durationMinutes,
      bufferMinutes,
      addonTiming: nullableText(raw.addon_timing),
    });
  }
  return lines;
}

function parseMember(
  raw: unknown,
  voucherCode: string | null,
): GroupBookingPricingMember | null {
  if (!record(raw)) return null;
  const memberIndex = cents(raw.member_index);
  const serviceId = text(raw.service_id);
  const staffId = text(raw.staff_id);
  const startTimeUtc = text(raw.start_time_utc);
  const endTimeUtc = text(raw.end_time_utc);
  const addonServiceIds = Array.isArray(raw.addon_service_ids)
    ? raw.addon_service_ids.map(text)
    : null;
  const addonLines = parseAddonLines(raw.addon_lines);
  const taxBreakdown = parseTaxLines(raw.tax_breakdown);
  const serviceOriginalCents = cents(raw.original_price_cents);
  const serviceNetCents = cents(raw.service_pre_voucher_cents);
  const serviceFinalCents = cents(raw.price_cents);
  const addonPreVoucherCents = cents(raw.addon_pre_voucher_cents);
  const addonCents = cents(raw.addon_price_cents);
  const promoDiscountCents = cents(raw.promo_discount_cents);
  const emailDiscountCents = cents(raw.email_discount_cents);
  const voucherDiscountCents = cents(raw.voucher_discount_cents);
  const preVoucherSubtotalCents = cents(raw.pre_voucher_subtotal_cents);
  const subtotalCents = cents(raw.subtotal_cents);
  const taxCents = cents(raw.tax_cents);
  const totalCents = cents(raw.total_cents);
  const taxAmountCents = raw.tax_amount_cents == null
    ? taxCents
    : cents(raw.tax_amount_cents);
  const trailingBufferMinutes = cents(raw.trailing_buffer_minutes);
  if (
    memberIndex == null ||
    !serviceId ||
    !staffId ||
    !startTimeUtc ||
    !endTimeUtc ||
    !Number.isFinite(Date.parse(startTimeUtc)) ||
    !Number.isFinite(Date.parse(endTimeUtc)) ||
    Date.parse(endTimeUtc) <= Date.parse(startTimeUtc) ||
    !addonServiceIds ||
    addonServiceIds.some((id) => !id) ||
    !addonLines ||
    !taxBreakdown ||
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
    totalCents == null ||
    taxAmountCents == null ||
    taxAmountCents !== taxCents ||
    trailingBufferMinutes == null
  ) return null;
  if (
    (raw.first_addon_id != null && !text(raw.first_addon_id)) ||
    (raw.promo_id != null && !text(raw.promo_id)) ||
    (raw.promo_name != null && !text(raw.promo_name))
  ) return null;
  const normalizedAddonServiceIds = addonServiceIds as string[];
  const addonLineIds = addonLines.map((line) => line.serviceId);
  const firstAddonId = nullableText(raw.first_addon_id);
  if (
    new Set(normalizedAddonServiceIds).size !== normalizedAddonServiceIds.length ||
    normalizedAddonServiceIds.length !== addonLineIds.length ||
    normalizedAddonServiceIds.some((id, index) => id !== addonLineIds[index]) ||
    firstAddonId !== (normalizedAddonServiceIds[0] ?? null) ||
    serviceOriginalCents - promoDiscountCents - emailDiscountCents !== serviceNetCents ||
    serviceNetCents + addonPreVoucherCents !== preVoucherSubtotalCents ||
    preVoucherSubtotalCents - voucherDiscountCents !== subtotalCents ||
    serviceFinalCents + addonCents !== subtotalCents ||
    subtotalCents + taxCents !== totalCents ||
    addonLines.reduce((sum, line) => sum + line.priceCents, 0) !== addonPreVoucherCents ||
    taxBreakdown.reduce((sum, line) => sum + line.amountCents, 0) !== taxCents
  ) return null;
  const promoName = nullableText(raw.promo_name);
  const discountLines: PublicBookingDiscountLine[] = [
    ...(promoDiscountCents > 0
      ? [{ kind: "promotion" as const, label: promoName ?? "Promotion", amountCents: promoDiscountCents }]
      : []),
    ...(emailDiscountCents > 0
      ? [{ kind: "email_incentive" as const, label: "Email incentive", amountCents: emailDiscountCents }]
      : []),
    ...(voucherDiscountCents > 0
      ? [{ kind: "voucher" as const, label: voucherCode ? `Voucher ${voucherCode}` : "Voucher", amountCents: voucherDiscountCents }]
      : []),
  ];
  return {
    memberIndex,
    serviceId,
    staffId,
    startTimeUtc,
    endTimeUtc,
    addonServiceIds: normalizedAddonServiceIds,
    addonLines,
    firstAddonId,
    trailingBufferMinutes,
    promoId: nullableText(raw.promo_id),
    promoName,
    serviceOriginalCents,
    serviceNetCents,
    serviceFinalCents,
    addonPreVoucherCents,
    addonCents,
    promoDiscountCents,
    emailDiscountCents,
    voucherDiscountCents,
    preVoucherSubtotalCents,
    subtotalCents,
    taxCents,
    totalCents,
    taxBreakdown,
    discountLines,
  };
}

/** Fail-closed parser for the one receipt shared by quote, create and done. */
export function parseGroupBookingPricingQuote(
  value: unknown,
  context: { voucherCode?: string | null } = {},
): GroupBookingPricingQuote | null {
  if (
    !record(value) ||
    value.success !== true ||
    (value.code !== "quoted" && value.code !== "booked") ||
    !Array.isArray(value.member_quotes)
  ) {
    return null;
  }
  const pricingFingerprint = text(value.pricing_fingerprint);
  const salonId = text(value.salon_id);
  const groupSize = cents(value.group_size);
  const currencyRaw = text(value.currency);
  const voucherCode = context.voucherCode?.trim().toUpperCase() || null;
  if (value.voucher_id != null && !text(value.voucher_id)) return null;
  if (
    !pricingFingerprint ||
    !/^[a-f0-9]{64}$/i.test(pricingFingerprint) ||
    !salonId ||
    groupSize == null ||
    groupSize < 2 ||
    groupSize > 20 ||
    value.member_quotes.length !== groupSize ||
    !currencyRaw ||
    !isSupportedCurrency(currencyRaw)
  ) return null;

  const members = value.member_quotes.map((member) => parseMember(member, voucherCode));
  if (members.some((member) => member == null)) return null;
  const memberQuotes = members as GroupBookingPricingMember[];
  if (
    memberQuotes.some((member, index) => member.memberIndex !== index) ||
    memberQuotes.some((member, index) => index > 0 && member.emailDiscountCents > 0) ||
    memberQuotes[0].emailDiscountCents > 200
  ) return null;

  const aggregateFields = {
    serviceOriginalCents: cents(value.original_price_cents),
    promoDiscountCents: cents(value.promo_discount_cents),
    emailDiscountCents: cents(value.email_discount_cents),
    voucherDiscountCents: cents(value.voucher_discount_cents),
    preVoucherSubtotalCents: cents(value.pre_voucher_subtotal_cents),
    subtotalCents: cents(value.subtotal_cents),
    taxCents: cents(value.tax_cents),
    totalCents: cents(value.total_cents),
  };
  if (Object.values(aggregateFields).some((amount) => amount == null)) return null;
  const taxBreakdown = parseTaxLines(value.tax_breakdown);
  if (!taxBreakdown) return null;
  if (
    value.tax_amount_cents != null &&
    cents(value.tax_amount_cents) !== aggregateFields.taxCents
  ) return null;
  const sums = (field: keyof GroupBookingPricingMember) =>
    memberQuotes.reduce((sum, member) => sum + Number(member[field]), 0);
  if (
    aggregateFields.serviceOriginalCents !== sums("serviceOriginalCents") ||
    aggregateFields.promoDiscountCents !== sums("promoDiscountCents") ||
    aggregateFields.emailDiscountCents !== sums("emailDiscountCents") ||
    aggregateFields.voucherDiscountCents !== sums("voucherDiscountCents") ||
    aggregateFields.preVoucherSubtotalCents !== sums("preVoucherSubtotalCents") ||
    aggregateFields.subtotalCents !== sums("subtotalCents") ||
    aggregateFields.taxCents !== sums("taxCents") ||
    aggregateFields.totalCents !== sums("totalCents") ||
    taxBreakdown.reduce((sum, line) => sum + line.amountCents, 0) !== aggregateFields.taxCents ||
    memberQuotes.some((member) => member.taxBreakdown.length !== taxBreakdown.length) ||
    taxBreakdown.some((line, lineIndex) =>
      memberQuotes.some((member) => {
        const memberLine = member.taxBreakdown[lineIndex];
        return memberLine.name !== line.name || memberLine.rate !== line.rate;
      }) ||
      memberQuotes.reduce(
        (sum, member) => sum + member.taxBreakdown[lineIndex].amountCents,
        0,
      ) !== line.amountCents
    )
  ) return null;
  const promoName = memberQuotes.find((member) => member.promoName)?.promoName ?? null;
  const discountLines: PublicBookingDiscountLine[] = [
    ...(aggregateFields.promoDiscountCents! > 0
      ? [{ kind: "promotion" as const, label: promoName ?? "Promotion", amountCents: aggregateFields.promoDiscountCents! }]
      : []),
    ...(aggregateFields.emailDiscountCents! > 0
      ? [{ kind: "email_incentive" as const, label: "Email incentive", amountCents: aggregateFields.emailDiscountCents! }]
      : []),
    ...(aggregateFields.voucherDiscountCents! > 0
      ? [{ kind: "voucher" as const, label: voucherCode ? `Voucher ${voucherCode}` : "Voucher", amountCents: aggregateFields.voucherDiscountCents! }]
      : []),
  ];
  return {
    pricingFingerprint,
    salonId,
    groupSize,
    currency: currencyRaw,
    voucherId: nullableText(value.voucher_id),
    voucherCode,
    serviceOriginalCents: aggregateFields.serviceOriginalCents!,
    promoDiscountCents: aggregateFields.promoDiscountCents!,
    emailDiscountCents: aggregateFields.emailDiscountCents!,
    voucherDiscountCents: aggregateFields.voucherDiscountCents!,
    preVoucherSubtotalCents: aggregateFields.preVoucherSubtotalCents!,
    subtotalCents: aggregateFields.subtotalCents!,
    taxCents: aggregateFields.taxCents!,
    totalCents: aggregateFields.totalCents!,
    taxBreakdown,
    memberQuotes,
    discountLines,
  };
}

/** Stable network shape. Browser callers run the same fail-closed parser over
 * this payload instead of trusting a TypeScript cast across HTTP. */
export function serializeGroupBookingPricingQuote(
  quote: GroupBookingPricingQuote,
): Record<string, unknown> {
  return {
    success: true,
    code: "quoted",
    pricing_fingerprint: quote.pricingFingerprint,
    salon_id: quote.salonId,
    group_size: quote.groupSize,
    currency: quote.currency,
    voucher_id: quote.voucherId,
    original_price_cents: quote.serviceOriginalCents,
    promo_discount_cents: quote.promoDiscountCents,
    email_discount_cents: quote.emailDiscountCents,
    voucher_discount_cents: quote.voucherDiscountCents,
    pre_voucher_subtotal_cents: quote.preVoucherSubtotalCents,
    subtotal_cents: quote.subtotalCents,
    tax_cents: quote.taxCents,
    tax_amount_cents: quote.taxCents,
    total_cents: quote.totalCents,
    tax_breakdown: quote.taxBreakdown.map((line) => ({
      name: line.name,
      rate: line.rate,
      amount_cents: line.amountCents,
    })),
    member_quotes: quote.memberQuotes.map((member) => ({
      member_index: member.memberIndex,
      service_id: member.serviceId,
      staff_id: member.staffId,
      start_time_utc: member.startTimeUtc,
      end_time_utc: member.endTimeUtc,
      addon_service_ids: member.addonServiceIds,
      addon_lines: member.addonLines.map((line) => ({
        service_id: line.serviceId,
        name: line.name,
        price_cents: line.priceCents,
        duration_minutes: line.durationMinutes,
        buffer_minutes: line.bufferMinutes,
        addon_timing: line.addonTiming,
      })),
      first_addon_id: member.firstAddonId,
      trailing_buffer_minutes: member.trailingBufferMinutes,
      promo_id: member.promoId,
      promo_name: member.promoName,
      original_price_cents: member.serviceOriginalCents,
      service_pre_voucher_cents: member.serviceNetCents,
      addon_pre_voucher_cents: member.addonPreVoucherCents,
      promo_discount_cents: member.promoDiscountCents,
      email_discount_cents: member.emailDiscountCents,
      voucher_discount_cents: member.voucherDiscountCents,
      price_cents: member.serviceFinalCents,
      addon_price_cents: member.addonCents,
      pre_voucher_subtotal_cents: member.preVoucherSubtotalCents,
      subtotal_cents: member.subtotalCents,
      tax_cents: member.taxCents,
      tax_amount_cents: member.taxCents,
      total_cents: member.totalCents,
      tax_breakdown: member.taxBreakdown.map((line) => ({
        name: line.name,
        rate: line.rate,
        amount_cents: line.amountCents,
      })),
    })),
  };
}

export function groupBookingPricingIntentKey(input: GroupBookingPricingRequest): string {
  return JSON.stringify({
    salonId: input.salonId,
    bookings: input.bookings.map((booking) => ({
      ...booking,
      addonServiceIds: [...booking.addonServiceIds],
      clientEmail: booking.clientEmail?.trim().toLowerCase() || null,
      clientPhone: booking.clientPhone?.replace(/\D/g, "") || null,
      clientName: booking.clientName?.trim() || "",
    })),
    voucherCode: input.voucherCode?.trim().toUpperCase() || null,
    applyEmailDiscount: input.applyEmailDiscount,
  });
}

/** Binds a parsed receipt back to every material booking input. */
export function groupBookingQuoteMatchesRequest(
  quote: GroupBookingPricingQuote,
  request: GroupBookingPricingRequest,
): boolean {
  const requestedVoucher = request.voucherCode?.trim().toUpperCase() || null;
  return (
    quote.salonId === request.salonId &&
    quote.groupSize === request.bookings.length &&
    quote.voucherCode === requestedVoucher &&
    (requestedVoucher === null ? quote.voucherId === null : quote.voucherId !== null) &&
    quote.memberQuotes.every((member, index) => {
      const booking = request.bookings[index];
      return Boolean(booking) &&
        member.memberIndex === index &&
        member.serviceId === booking.serviceId &&
        member.staffId === booking.staffId &&
        // Postgres serializes UTC as `+00:00`, while browser requests commonly
        // use `.000Z`. Bind the quote to the exact instants, not one equivalent
        // ISO spelling, or every valid server receipt is rejected client-side.
        groupBookingInstantMatches(member.startTimeUtc, booking.startTimeUtc) &&
        groupBookingInstantMatches(member.endTimeUtc, booking.endTimeUtc) &&
        member.addonServiceIds.length === booking.addonServiceIds.length &&
        member.addonServiceIds.every(
          (id, addonIndex) => id === booking.addonServiceIds[addonIndex],
        );
    })
  );
}

export type GroupBookingIdempotencyState = {
  intentKey: string | null;
  key: string;
};

/** Same logical intent (including a pricing_changed reconfirm) keeps its key. */
export function groupBookingIdempotencyForIntent(
  state: GroupBookingIdempotencyState,
  intentKey: string,
  nextKey: string,
): GroupBookingIdempotencyState {
  return state.intentKey === intentKey ? state : { intentKey, key: nextKey };
}

/** Called only after acknowledged success; no error transition uses it. */
export function resetGroupBookingIdempotency(
  nextKey: string,
): GroupBookingIdempotencyState {
  return { intentKey: null, key: nextKey };
}
