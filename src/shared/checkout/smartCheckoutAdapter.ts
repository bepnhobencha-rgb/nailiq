import type {
  SmartCheckoutProvider,
  SmartCheckoutStatus,
  SmartCheckoutTender,
} from "@/shared/checkout/smartCheckout";

export type SmartCheckoutDispatchInput = {
  operationId: string;
  bookingId: string;
  salonId: string;
  amountCents: number;
  currency: string;
  providerAccountId: string;
  providerLocationId: string | null;
  providerDeviceId: string | null;
  tender: SmartCheckoutTender;
  idempotencyKey: string;
  referenceId: string;
};

export type SmartCheckoutProviderReceipt = {
  provider: SmartCheckoutProvider;
  checkoutId: string;
  paymentId: string | null;
  providerStatus: string;
  evidence: {
    amountCents: number | null;
    currency: string | null;
    providerAccountId: string | null;
    providerLocationId: string | null;
    providerDeviceId: string | null;
    /** Provider-authored receipt/update time, never browser or worker time. */
    occurredAt: string | null;
  };
  status: Extract<
    SmartCheckoutStatus,
    | "awaiting_customer"
    | "pending_provider"
    | "outcome_unknown"
    | "paid"
    | "failed"
    | "cancelled"
  >;
};

export type SmartCheckoutRetrieveInput = {
  checkoutId: string;
  providerAccountId: string;
  providerLocationId: string | null;
};

export type SmartCheckoutCancelInput = SmartCheckoutRetrieveInput & {
  idempotencyKey: string;
};

/**
 * Terminal/card-present contract shared by Square and Stripe. Implementations
 * must return `outcome_unknown` after an ambiguous network/provider response;
 * callers reconcile the same checkout before any redispatch.
 */
export interface SmartCheckoutAdapter {
  readonly provider: SmartCheckoutProvider;
  createCheckout(input: SmartCheckoutDispatchInput): Promise<SmartCheckoutProviderReceipt>;
  retrieveCheckout(input: SmartCheckoutRetrieveInput): Promise<SmartCheckoutProviderReceipt>;
  cancelCheckout(input: SmartCheckoutCancelInput): Promise<SmartCheckoutProviderReceipt>;
}
