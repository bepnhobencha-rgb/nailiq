export const GO_LIVE_ATTESTATION_KEYS = [
  "hours_confirmed",
  "otp_policy_confirmed",
  "live_rehearsal_completed",
  "owner_approved",
] as const;

export type GoLiveAttestationKey =
  (typeof GO_LIVE_ATTESTATION_KEYS)[number];
export type GoLiveAttestationAction = "attest" | "revoke";

export function isGuidedPilotAttestationBlocked(
  guidedSetupEnabled: boolean,
  checkKey: GoLiveAttestationKey,
): boolean {
  return (
    guidedSetupEnabled &&
    (checkKey === "live_rehearsal_completed" || checkKey === "owner_approved")
  );
}

export type GoLiveAttestationEvent = {
  id: string;
  checkKey: GoLiveAttestationKey;
  action: GoLiveAttestationAction;
  evidenceNote: string;
  actorRole: "owner" | "admin";
  readinessSnapshotHash: string | null;
  createdAt: string;
};

export type GoLiveAttestationState = {
  hoursConfirmed: boolean;
  otpPolicyConfirmed: boolean;
  liveRehearsalCompleted: boolean;
  ownerApproved: boolean;
  ownerApprovalStale: boolean;
};

const keyToState = {
  hours_confirmed: "hoursConfirmed",
  otp_policy_confirmed: "otpPolicyConfirmed",
  live_rehearsal_completed: "liveRehearsalCompleted",
} as const;

export function deriveGoLiveAttestationState(
  events: GoLiveAttestationEvent[],
  currentSnapshotHash: string,
): GoLiveAttestationState {
  const latest = new Map<GoLiveAttestationKey, GoLiveAttestationEvent>();
  for (const event of events) {
    if (!latest.has(event.checkKey)) latest.set(event.checkKey, event);
  }

  const state: GoLiveAttestationState = {
    hoursConfirmed: false,
    otpPolicyConfirmed: false,
    liveRehearsalCompleted: false,
    ownerApproved: false,
    ownerApprovalStale: false,
  };

  for (const [key, stateKey] of Object.entries(keyToState) as Array<
    [keyof typeof keyToState, (typeof keyToState)[keyof typeof keyToState]]
  >) {
    state[stateKey] = latest.get(key)?.action === "attest";
  }

  const ownerApproval = latest.get("owner_approved");
  if (ownerApproval?.action === "attest") {
    state.ownerApprovalStale =
      ownerApproval.readinessSnapshotHash !== currentSnapshotHash;
    state.ownerApproved = !state.ownerApprovalStale;
  }

  return state;
}

export function allGoLivePrerequisitesConfirmed(
  state: GoLiveAttestationState,
): boolean {
  return (
    state.hoursConfirmed &&
    state.otpPolicyConfirmed &&
    state.liveRehearsalCompleted
  );
}
