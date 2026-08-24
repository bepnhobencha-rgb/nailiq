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
  googleCalendarSync: "phase_2",
  outlookCalendarSync: "phase_2",
  wixCalendarSync: "legacy_existing_only",
  squareLoyaltySync: "phase_2_provider_owned",
  squareGiftCardSync: "phase_2_provider_owned",
  archivedBookingRecovery: "phase_2",
} as const);

/**
 * V1 never asks NailIQ to create, charge, refund, reconcile, or store a
 * customer's provider payment method. Salons continue checkout directly in
 * Square; this fail-closed predicate is the shared server boundary for the
 * dormant Square/Stripe payment foundation.
 */
export function v1AllowsCustomerPaymentGateway(): boolean {
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
