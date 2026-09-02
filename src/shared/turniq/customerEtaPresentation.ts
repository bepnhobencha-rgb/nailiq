import type { TurnIqCustomerEtaProjection } from "@/shared/turniq/customerEta";

export type TurnIqCustomerEtaPresentationInput = Omit<
  TurnIqCustomerEtaProjection,
  "snapshotVersion"
>;

export type TurnIqCustomerEtaPresentation = {
  headline: string;
  detail: string;
  waitLabel: string | null;
  partyLabel: string | null;
  limitedConnection: boolean;
};

export function presentTurnIqCustomerEta(
  eta: TurnIqCustomerEtaPresentationInput,
  nowMs: number,
  connectionLimited: boolean,
): TurnIqCustomerEtaPresentation {
  const refreshByMs = Date.parse(eta.refreshBy);
  const expiredRange =
    (eta.surface === "waiting" || eta.surface === "last_known") &&
    (!Number.isFinite(refreshByMs) || nowMs > refreshByMs);
  if (expiredRange) {
    return {
      headline: "Updating your wait",
      detail: "We are safely refreshing your wait range. Please keep this page open.",
      waitLabel: null,
      partyLabel: null,
      limitedConnection: connectionLimited,
    };
  }
  const waitLabel = eta.waitRange
    ? `${eta.waitRange.earliestMinutes}–${eta.waitRange.latestMinutes} min`
    : null;
  const partyLabel = eta.partyFullyStartedRange
    ? `Everyone expected to start within ${eta.partyFullyStartedRange.earliestMinutes}–${eta.partyFullyStartedRange.latestMinutes} min`
    : null;
  return {
    headline: waitLabel ? "Your estimated wait" : "Visit update",
    detail: eta.message.en,
    waitLabel,
    partyLabel,
    limitedConnection: connectionLimited || eta.surface === "last_known",
  };
}
