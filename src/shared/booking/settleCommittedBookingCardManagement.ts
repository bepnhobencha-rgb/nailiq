export type CommittedBookingCardManagementResult = {
  cardManagementToken: string | null;
  cardManagementPending: boolean;
};

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type ReuseSavedCard = () => Promise<{
  ok: boolean;
  reason?: string;
}>;

const CARD_MANAGEMENT_STEP_TIMEOUT_MS = 5_000;

async function withinCardManagementDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("card_management_timeout"));
        }, CARD_MANAGEMENT_STEP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

type SettleCommittedBookingCardManagementInput = {
  /** Narrow release gate for card-on-file only; customer money movement stays off. */
  customerPaymentGatewayEnabled: boolean;
  salonId: string;
  bookingId: string;
  createIdempotencyKey: string;
  pricingFingerprint: string;
  cardSourceId?: string | null;
  cardVerificationToken?: string | null;
  consent?: boolean;
  reuseSavedCard?: ReuseSavedCard;
};

/**
 * Settles the card-only continuation after the canonical booking receipt exists.
 *
 * The booking outcome is no longer conditional on this work. In particular,
 * an ambiguous provider response is never retried here: a fresh capability can
 * create a fresh provider operation identity. The safe outcome is a bounded,
 * visible card-only unresolved state. The card-on-file path is enabled only
 * with durable dispatch preparation and read-only response-loss reconciliation.
 */
export async function settleCommittedBookingCardManagement(
  input: SettleCommittedBookingCardManagementInput,
  fetcher: FetchLike = fetch,
): Promise<CommittedBookingCardManagementResult> {
  if (!input.customerPaymentGatewayEnabled) {
    return { cardManagementToken: null, cardManagementPending: false };
  }

  let cardManagementToken: string | null = null;

  try {
    const { response, value } = await withinCardManagementDeadline(async (signal) => {
      const capabilityResponse = await fetcher("/api/booking/card-capability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          salonId: input.salonId,
          bookingId: input.bookingId,
          idempotencyKey: input.createIdempotencyKey,
          pricingFingerprint: input.pricingFingerprint,
        }),
        signal,
      });
      const capabilityValue = await capabilityResponse.json().catch(() => null) as {
        ok?: boolean;
        token?: string | null;
      } | null;
      return { response: capabilityResponse, value: capabilityValue };
    });
    if (!response.ok || value?.ok !== true) {
      return { cardManagementToken: null, cardManagementPending: true };
    }
    cardManagementToken = typeof value.token === "string" ? value.token : null;
  } catch {
    return { cardManagementToken: null, cardManagementPending: true };
  }

  if (input.cardSourceId) {
    if (!cardManagementToken || input.consent !== true) {
      return {
        cardManagementToken,
        cardManagementPending: true,
      };
    }

    try {
      const { response, value } = await withinCardManagementDeadline(async (signal) => {
        const saveResponse = await fetcher("/api/booking/square-save-card", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: cardManagementToken,
            requestId: input.createIdempotencyKey,
            provider: "square",
            sourceId: input.cardSourceId,
            verificationToken: input.cardVerificationToken ?? undefined,
            consent: true,
          }),
          signal,
        });
        const saveValue = await saveResponse.json().catch(() => null) as {
          ok?: boolean;
        } | null;
        return { response: saveResponse, value: saveValue };
      });
      if (response.ok && value?.ok === true) {
        return { cardManagementToken: null, cardManagementPending: false };
      }
    } catch {
      // The provider outcome may be unknown. Never issue a second save here.
    }

    return { cardManagementToken: null, cardManagementPending: true };
  }

  const reuseSavedCard = input.reuseSavedCard;
  if (reuseSavedCard) {
    try {
      const reused = await withinCardManagementDeadline(() => reuseSavedCard());
      if (reused.ok) {
        return { cardManagementToken: null, cardManagementPending: false };
      }
    } catch {
      // Reuse is best-effort after commit; the booking result remains final.
    }
    return { cardManagementToken: null, cardManagementPending: true };
  }

  return {
    cardManagementToken,
    cardManagementPending: cardManagementToken !== null,
  };
}
