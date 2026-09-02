import {
  fingerprintTurnIqCustomerEta,
  measureTurnIqCustomerEtaAccuracy,
  type TurnIqCustomerEtaProjection,
} from "@/shared/turniq/customerEta";
import {
  canonicalTurnIqJson,
  sha256TurnIqHex,
} from "@/shared/turniq/fingerprint";

export type TurnIqCustomerEtaObservation = {
  version: 1;
  estimateFingerprint: string;
  observationFingerprint: string;
  observedStartAt: string;
  outcome: "early" | "within_range" | "late";
  deviationMinutes: number;
  predictedWidthMinutes: number;
};

/**
 * Builds a PII-free accuracy observation from a previously issued ETA. The
 * caller must persist it only behind a salon-scoped, idempotent server command.
 */
export async function createTurnIqCustomerEtaObservation(input: {
  projection: TurnIqCustomerEtaProjection;
  observedStartAt: string;
}): Promise<TurnIqCustomerEtaObservation> {
  const observedMs = Date.parse(input.observedStartAt);
  if (!Number.isFinite(observedMs)) throw new Error("turniq_eta_invalid_observed_start");
  const observedStartAt = new Date(observedMs).toISOString();
  const estimateFingerprint = await fingerprintTurnIqCustomerEta(input.projection);
  const accuracy = measureTurnIqCustomerEtaAccuracy(
    input.projection,
    observedStartAt,
  );
  const observationFingerprint = await sha256TurnIqHex(canonicalTurnIqJson({
    version: 1,
    estimateFingerprint,
    observedStartAt,
    ...accuracy,
  }));
  return {
    version: 1,
    estimateFingerprint,
    observationFingerprint,
    observedStartAt,
    ...accuracy,
  };
}
