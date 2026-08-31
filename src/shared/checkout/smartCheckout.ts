export const SMART_CHECKOUT_PROVIDERS = ["square", "stripe"] as const;
export type SmartCheckoutProvider = (typeof SMART_CHECKOUT_PROVIDERS)[number];

export const SMART_CHECKOUT_TENDERS = [
  "terminal",
  "tap_to_pay",
  "payment_link",
  "card_on_file",
] as const;
export type SmartCheckoutTender = (typeof SMART_CHECKOUT_TENDERS)[number];

export const SMART_CHECKOUT_STATUSES = [
  "draft",
  "ready_for_review",
  "awaiting_customer",
  "pending_provider",
  "outcome_unknown",
  "partially_paid",
  "paid",
  "failed",
  "cancelled",
] as const;
export type SmartCheckoutStatus = (typeof SMART_CHECKOUT_STATUSES)[number];

export type SmartCheckoutItem = {
  id: string;
  label: string;
  kind: "service" | "addon";
  quantity: number;
  unitAmountCents: number;
};

export type SmartCheckoutQuoteInput = {
  currency: string;
  items: SmartCheckoutItem[];
  discountCents?: number;
  taxCents?: number;
  tipCents?: number;
  depositPaidCents?: number;
};

export type SmartCheckoutQuote = {
  currency: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  tipCents: number;
  depositCreditCents: number;
  amountDueCents: number;
  lineCount: number;
  material: SmartCheckoutQuoteInput;
};

export type SmartCheckoutQuoteResult =
  | { ok: true; quote: SmartCheckoutQuote }
  | {
      ok: false;
      error:
        | "invalid_currency"
        | "empty_cart"
        | "invalid_item"
        | "invalid_amount"
        | "discount_exceeds_subtotal";
    };

const CURRENCY_RE = /^[A-Z]{3}$/u;

function nonNegativeInteger(value: number | undefined): number | null {
  const resolved = value ?? 0;
  return Number.isSafeInteger(resolved) && resolved >= 0 ? resolved : null;
}

/**
 * Canonical Smart Checkout math. The caller must provide server-owned service,
 * add-on, discount, tax, tip, and captured-deposit facts. This function never
 * reads browser totals and never performs a provider call.
 *
 * Deposit credit intentionally cannot consume a newly added tip: a deposit is
 * payment toward the booked service total, while the customer chooses tip at
 * checkout. Any excess historical deposit must be handled as a refund, not as
 * hidden tip settlement.
 */
export function quoteSmartCheckout(
  input: SmartCheckoutQuoteInput,
): SmartCheckoutQuoteResult {
  const currency = input.currency.trim().toUpperCase();
  if (!CURRENCY_RE.test(currency)) return { ok: false, error: "invalid_currency" };
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return { ok: false, error: "empty_cart" };
  }

  let subtotalCents = 0;
  for (const item of input.items) {
    if (
      !item ||
      (item.kind !== "service" && item.kind !== "addon") ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      typeof item.label !== "string" ||
      !item.label.trim() ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 99 ||
      !Number.isSafeInteger(item.unitAmountCents) ||
      item.unitAmountCents < 0
    ) {
      return { ok: false, error: "invalid_item" };
    }
    const lineTotal = item.quantity * item.unitAmountCents;
    if (!Number.isSafeInteger(lineTotal)) {
      return { ok: false, error: "invalid_item" };
    }
    subtotalCents += lineTotal;
    if (!Number.isSafeInteger(subtotalCents)) {
      return { ok: false, error: "invalid_item" };
    }
  }

  const discountCents = nonNegativeInteger(input.discountCents);
  const taxCents = nonNegativeInteger(input.taxCents);
  const tipCents = nonNegativeInteger(input.tipCents);
  const depositPaidCents = nonNegativeInteger(input.depositPaidCents);
  if (
    discountCents === null ||
    taxCents === null ||
    tipCents === null ||
    depositPaidCents === null
  ) {
    return { ok: false, error: "invalid_amount" };
  }
  if (discountCents > subtotalCents) {
    return { ok: false, error: "discount_exceeds_subtotal" };
  }

  const serviceTotalCents = subtotalCents - discountCents + taxCents;
  const depositCreditCents = Math.min(depositPaidCents, serviceTotalCents);
  const amountDueCents = serviceTotalCents + tipCents - depositCreditCents;
  if (!Number.isSafeInteger(amountDueCents) || amountDueCents < 0) {
    return { ok: false, error: "invalid_amount" };
  }

  return {
    ok: true,
    quote: {
      currency,
      subtotalCents,
      discountCents,
      taxCents,
      tipCents,
      depositCreditCents,
      amountDueCents,
      lineCount: input.items.reduce((sum, item) => sum + item.quantity, 0),
      material: {
        currency,
        items: input.items.map((item) => ({ ...item })),
        discountCents,
        taxCents,
        tipCents,
        depositPaidCents,
      },
    },
  };
}

export type SmartCheckoutReadinessInput = {
  selectedProvider: SmartCheckoutProvider | null;
  providerConnected: boolean;
  payoutsReady: boolean;
  webhooksReady: boolean;
  deviceReady: boolean;
  dispatchEnabled: boolean;
};

export type SmartCheckoutReadiness = {
  readyForSimulation: true;
  readyForLiveMoney: boolean;
  blockers: Array<
    | "provider_not_selected"
    | "provider_not_connected"
    | "payouts_not_ready"
    | "webhooks_not_ready"
    | "device_not_ready"
    | "dispatch_disabled"
  >;
};

/** A salon is never called live-ready from a connection badge alone. */
export function evaluateSmartCheckoutReadiness(
  input: SmartCheckoutReadinessInput,
): SmartCheckoutReadiness {
  const blockers: SmartCheckoutReadiness["blockers"] = [];
  if (!input.selectedProvider) blockers.push("provider_not_selected");
  if (!input.providerConnected) blockers.push("provider_not_connected");
  if (!input.payoutsReady) blockers.push("payouts_not_ready");
  if (!input.webhooksReady) blockers.push("webhooks_not_ready");
  if (!input.deviceReady) blockers.push("device_not_ready");
  if (!input.dispatchEnabled) blockers.push("dispatch_disabled");
  return {
    readyForSimulation: true,
    readyForLiveMoney: blockers.length === 0,
    blockers,
  };
}

