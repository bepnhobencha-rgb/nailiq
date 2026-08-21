import "server-only";

/**
 * Provider-agnostic payment interface for CUSTOMER money flows (no-show
 * card-on-file + deposits). One salon = one provider, chosen at setup
 * (`salons.payment_provider`). Square + Stripe both implement this so the rest
 * of the app never branches on provider.
 *
 * Card-on-file model: save a tokenized card with NO charge; charge later only
 * on a confirmed no-show (staff-decided). Idempotency keys are caller-supplied
 * where charge-once matters (e.g. `noshow:<bookingId>`).
 */

export type PaymentProviderKind = "square" | "stripe";

export interface PaymentCustomerInput {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  /** Stable reference for matching/dedupe, e.g. "booking:<id>". */
  referenceId: string;
}

export interface SavedCard {
  customerId: string;
  cardId: string;
  last4: string;
  brand: string;
}

export interface ChargeResult {
  paymentId: string;
  status: string;
}

export interface RefundResult {
  refundId: string;
  status: string;
}

export interface PaymentProvider {
  readonly kind: PaymentProviderKind;

  /** Match/create the customer and save a tokenized card on file — NO charge.
   *  `sourceToken` is the client tokenization result (Square Web Payments SDK
   *  nonce / Stripe PaymentMethod or SetupIntent). */
  saveCardOnFile(input: {
    customer: PaymentCustomerInput;
    sourceToken: string;
    /** Optional legacy Square verification token. Current Square clients embed
     *  buyer verification in the tokenization request. Stripe ignores this
     *  field because it verifies via the SetupIntent. */
    verificationToken?: string;
    /** Stable per durable card-save operation. Provider retries must reuse it. */
    idempotencyKey: string;
  }): Promise<SavedCard>;

  /** Charge a previously-saved card. `idempotencyKey` MUST be stable per logical
   *  charge so retries never double-bill. */
  chargeSavedCard(input: {
    customerId: string;
    cardId: string;
    amountCents: number;
    idempotencyKey: string;
    note?: string;
    referenceId?: string;
    /** DB-bound connected account for Stripe Connect. Square ignores this
     * field because its provider instance is already tenant-configured. */
    providerAccountId?: string;
  }): Promise<ChargeResult>;

  /** Refund a payment (full or partial). */
  refund(input: {
    paymentId: string;
    amountCents: number;
    reason: string;
    idempotencyKey: string;
    /** DB-bound connected account for Stripe Connect refunds. */
    providerAccountId?: string;
  }): Promise<RefundResult>;

  /** Remove a saved card so it can never be charged again. Square disables the
   *  card; Stripe detaches the payment method. Required by the card networks'
   *  stored-credential rules (the cardholder must be able to cancel). */
  removeSavedCard(input: { cardId: string; customerId: string }): Promise<{
    /** Exact provider object affected by the accepted removal. */
    providerReference: string;
  }>;

  /** Find a returning customer's most recent saved card by their (OTP-verified)
   *  phone — for one-tap reuse. READ ONLY. Returns null when none. Square: search
   *  customer by phone → list cards. Stripe: search customer by phone → list
   *  payment methods. Caller MUST gate on an OTP session (phone is the key). */
  findSavedCardByPhone(phone: string): Promise<SavedCard | null>;
}
