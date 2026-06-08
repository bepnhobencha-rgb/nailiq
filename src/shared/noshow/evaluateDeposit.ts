export type DepositReason =
  | "new_customer"
  | "previous_no_show"
  | "high_value_service"
  | "rule_applied";

export type DepositDecision = {
  required: boolean;
  amountCents: number;
  reason: DepositReason | null;
  /** Human-readable explanation for the owner dashboard. */
  explanation: string;
};

export type DepositInput = {
  isNewCustomer: boolean;
  previousNoShowCount: number;
  isVip: boolean;
  servicePriceCents: number;
  highValueThresholdCents: number;
  /** Owner override — when set, overrides all rules. */
  ownerOverride?: "require" | "waive" | null;
  /** Per-salon deposit percentages (0–100). Admin-configurable, no hardcode.
   *  Omit → safe defaults that preserve historical behavior. */
  pctNoShow?: number;
  pctHighValue?: number;
  pctNewCustomer?: number;
};

/** Clamp a percentage to 0–1 fraction; fall back to `def` (0–1) when invalid. */
function pctFraction(pct: number | undefined, def: number): number {
  if (pct == null || !Number.isFinite(pct)) return def;
  return Math.min(100, Math.max(0, pct)) / 100;
}

/**
 * Pure deposit rule engine.
 * Priority: VIP exemption > owner override > no-show history > high value > new customer.
 * Returns a deterministic decision with no side effects.
 */
export function evaluateDeposit(input: DepositInput): DepositDecision {
  const {
    isNewCustomer,
    previousNoShowCount,
    isVip,
    servicePriceCents,
    highValueThresholdCents,
    ownerOverride,
  } = input;

  // Configurable fractions (defaults preserve the prior 50/30/20 behavior).
  const fNoShow = pctFraction(input.pctNoShow, 0.5);
  const fHighValue = pctFraction(input.pctHighValue, 0.3);
  const fNewCustomer = pctFraction(input.pctNewCustomer, 0.2);

  const noRequired: DepositDecision = {
    required: false,
    amountCents: 0,
    reason: null,
    explanation: "No deposit required",
  };

  // Owner explicit override takes precedence over everything (including VIP status).
  // "require" forces a deposit even for VIPs; "waive" skips deposit for everyone.
  if (ownerOverride === "require") {
    return {
      required: true,
      amountCents: Math.round(servicePriceCents * fHighValue),
      reason: "rule_applied",
      explanation: "Deposit required by owner rule",
    };
  }

  if (ownerOverride === "waive") return noRequired;

  // VIP always exempt — second-highest priority (after owner override)
  if (isVip) return noRequired;

  // Previous no-show: require 50% deposit
  if (previousNoShowCount > 0) {
    return {
      required: true,
      amountCents: Math.round(servicePriceCents * fNoShow),
      reason: "previous_no_show",
      explanation: `Customer has ${previousNoShowCount} previous no-show(s)`,
    };
  }

  // High-value service: require 30% deposit
  if (servicePriceCents >= highValueThresholdCents) {
    return {
      required: true,
      amountCents: Math.round(servicePriceCents * fHighValue),
      reason: "high_value_service",
      explanation: `Service price $${(servicePriceCents / 100).toFixed(2)} exceeds high-value threshold`,
    };
  }

  // New customer: require 20% deposit
  if (isNewCustomer) {
    return {
      required: true,
      amountCents: Math.round(servicePriceCents * fNewCustomer),
      reason: "new_customer",
      explanation: "First-time customer",
    };
  }

  return noRequired;
}
