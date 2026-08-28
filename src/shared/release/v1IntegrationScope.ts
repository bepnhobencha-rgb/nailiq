/**
 * Product-owner-approved NailIQ V1 integration boundary (2026-08-24).
 *
 * V1 keeps NailIQ authoritative for website, booking and salon operations.
 * Payment, Square Loyalty and Square Gift Cards remain operated directly in
 * Square. New external-calendar connections and the optional Square sync
 * products move to Phase 2 and must not be advertised as available in V1.
 *
 * Existing Wix connections are preserved as legacy compatibility so a scope
 * correction cannot silently interrupt a salon that is already live.
 */
export const V1_INTEGRATION_SCOPE = Object.freeze({
  paymentGatewayIntegration: "phase_2_provider_terminal",
  nailiqSubscriptionAutomation: "phase_2_manual_billing_v1",
  googleCalendarSync: "phase_2",
  outlookCalendarSync: "phase_2",
  wixCalendarSync: "legacy_existing_only",
  squareOperationalSync: "phase_2",
  squareLoyaltySync: "phase_2_provider_owned",
  squareGiftCardSync: "phase_2_provider_owned",
  archivedBookingRecovery: "phase_2",
} as const);

/**
 * V1 never asks NailIQ to charge or refund customer money. Salons continue
 * checkout directly in Square; this fail-closed predicate is the shared server
 * boundary for deposits, charges and refunds. The narrower no-show card-on-file
 * exception below carries no money movement.
 */
export function v1AllowsCustomerPaymentGateway(): boolean {
  return false;
}

/**
 * Square appointment/customer operational sync is not part of V1. The two
 * live salons keep using Square independently for checkout, loyalty and gift
 * cards; this predicate must fail before any database inventory or Square API
 * access from the scheduled sync worker.
 */
export function v1AllowsSquareOperationalSync(): boolean {
  return false;
}

/**
 * Narrow exception approved for booking protection: tokenize and vault a card
 * without charging it. Money movement, deposits and refunds remain behind the
 * broader fail-closed gateway boundary above.
 */
export function v1AllowsNoShowCardOnFile(): boolean {
  return true;
}

/**
 * V1 subscription collection is coordinated manually by NailIQ. The in-app
 * Stripe Checkout, Customer Portal and subscription-webhook state machine stay
 * unavailable until their durable idempotency/replay contract ships in Phase 2.
 */
export function v1AllowsAutomatedSubscriptionBilling(): boolean {
  return false;
}

/**
 * Archived Booking Recovery stays dormant in V1. Its linked-child and audit
 * write must become one authoritative transaction before a later release may
 * expose the workflow to any salon.
 */
export function v1AllowsArchivedBookingRecovery(): boolean {
  return false;
}

export function v1AllowsWixCalendarConnection(
  existingConnection: boolean,
): boolean {
  return (
    V1_INTEGRATION_SCOPE.wixCalendarSync === "legacy_existing_only" &&
    existingConnection
  );
}
