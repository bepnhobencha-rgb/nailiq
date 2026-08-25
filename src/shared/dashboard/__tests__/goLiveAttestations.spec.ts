import { describe, expect, it } from "vitest";
import {
  allGoLivePrerequisitesConfirmed,
  deriveGoLiveAttestationState,
  isGuidedPilotAttestationBlocked,
  type GoLiveAttestationEvent,
} from "@/shared/dashboard/goLiveAttestations";

function event(
  overrides: Partial<GoLiveAttestationEvent> &
    Pick<GoLiveAttestationEvent, "checkKey" | "action">,
): GoLiveAttestationEvent {
  return {
    id: crypto.randomUUID(),
    evidenceNote: "Verified with salon owner.",
    actorRole: "owner",
    readinessSnapshotHash: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("go-live attestation state", () => {
  it("blocks rehearsal and final approval only for the Guided QA pilot", () => {
    expect(
      isGuidedPilotAttestationBlocked(true, "live_rehearsal_completed"),
    ).toBe(true);
    expect(isGuidedPilotAttestationBlocked(true, "owner_approved")).toBe(true);
    expect(isGuidedPilotAttestationBlocked(true, "hours_confirmed")).toBe(false);
    expect(
      isGuidedPilotAttestationBlocked(false, "live_rehearsal_completed"),
    ).toBe(false);
    expect(isGuidedPilotAttestationBlocked(false, "owner_approved")).toBe(false);
  });

  it("uses the latest append-only event for every confirmation", () => {
    const state = deriveGoLiveAttestationState(
      [
        event({ checkKey: "hours_confirmed", action: "revoke" }),
        event({ checkKey: "hours_confirmed", action: "attest" }),
        event({ checkKey: "otp_policy_confirmed", action: "attest" }),
        event({ checkKey: "live_rehearsal_completed", action: "attest" }),
      ],
      "a".repeat(64),
    );

    expect(state.hoursConfirmed).toBe(false);
    expect(state.otpPolicyConfirmed).toBe(true);
    expect(state.liveRehearsalCompleted).toBe(true);
    expect(allGoLivePrerequisitesConfirmed(state)).toBe(false);
  });

  it("accepts owner approval only for the current readiness fingerprint", () => {
    const currentHash = "b".repeat(64);
    const current = deriveGoLiveAttestationState(
      [
        event({
          checkKey: "owner_approved",
          action: "attest",
          readinessSnapshotHash: currentHash,
        }),
      ],
      currentHash,
    );
    const changed = deriveGoLiveAttestationState(
      [
        event({
          checkKey: "owner_approved",
          action: "attest",
          readinessSnapshotHash: "c".repeat(64),
        }),
      ],
      currentHash,
    );

    expect(current).toMatchObject({
      ownerApproved: true,
      ownerApprovalStale: false,
    });
    expect(changed).toMatchObject({
      ownerApproved: false,
      ownerApprovalStale: true,
    });
  });

  it("treats an explicit revocation as not approved", () => {
    const state = deriveGoLiveAttestationState(
      [
        event({
          checkKey: "owner_approved",
          action: "revoke",
          readinessSnapshotHash: "d".repeat(64),
        }),
      ],
      "d".repeat(64),
    );

    expect(state.ownerApproved).toBe(false);
    expect(state.ownerApprovalStale).toBe(false);
  });
});
