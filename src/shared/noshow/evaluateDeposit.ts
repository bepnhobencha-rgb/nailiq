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
};

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
      amountCents: Math.round(servicePriceCents * 0.3),
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
      amountCents: Math.round(servicePriceCents * 0.5),
      reason: "previous_no_show",
      explanation: `Customer has ${previousNoShowCount} previous no-show(s)`,
    };
  }

  // High-value service: require 30% deposit
  if (servicePriceCents >= highValueThresholdCents) {
    return {
      required: true,
      amountCents: Math.round(servicePriceCents * 0.3),
      reason: "high_value_service",
      explanation: `Service price $${(servicePriceCents / 100).toFixed(2)} exceeds high-value threshold`,
    };
  }

  // New customer: require 20% deposit
  if (isNewCustomer) {
    return {
      required: true,
      amountCents: Math.round(servicePriceCents * 0.2),
      reason: "new_customer",
      explanation: "First-time customer",
    };
  }

  return noRequired;
}
