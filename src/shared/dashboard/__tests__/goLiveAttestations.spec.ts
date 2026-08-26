import { describe, expect, it } from "vitest";
import {
  allGoLivePrerequisitesConfirmed,
  deriveGoLiveAttestationState,
  isGuidedPilotAttestationBlocked,
  type GoLiveAttestationEvent,
} from "@/shared/dashboard/goLiveAttestations";
import {
  createGoLiveApprovalSnapshotHash,
  createGoLiveReadinessSnapshotHash,
} from "@/shared/dashboard/goLiveReadinessSnapshot";

function event(
  overrides: Partial<GoLiveAttestationEvent> &
    Pick<GoLiveAttestationEvent, "checkKey" | "action">,
): GoLiveAttestationEvent {
  return {
    id: crypto.randomUUID(),
    evidenceNote: "Verified with salon owner.",
    actorRole: "owner",
    readinessSnapshotHash: "a".repeat(64),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("go-live attestation state", () => {
  it("blocks guided rehearsal and approval only when safe preview is unavailable", () => {
    expect(
      isGuidedPilotAttestationBlocked(
        true,
        "live_rehearsal_completed",
        false,
      ),
    ).toBe(true);
    expect(
      isGuidedPilotAttestationBlocked(true, "owner_approved", false),
    ).toBe(true);
    expect(
      isGuidedPilotAttestationBlocked(true, "owner_approved", true),
    ).toBe(false);
    expect(
      isGuidedPilotAttestationBlocked(true, "hours_confirmed", false),
    ).toBe(false);
    expect(
      isGuidedPilotAttestationBlocked(
        false,
        "live_rehearsal_completed",
        false,
      ),
    ).toBe(false);
    expect(
      isGuidedPilotAttestationBlocked(false, "owner_approved", false),
    ).toBe(false);
  });

  it("invalidates every prerequisite when the reviewed configuration changes", () => {
    const priorHash = "a".repeat(64);
    const currentHash = "b".repeat(64);
    const state = deriveGoLiveAttestationState(
      [
        event({
          checkKey: "hours_confirmed",
          action: "attest",
          readinessSnapshotHash: priorHash,
        }),
        event({
          checkKey: "otp_policy_confirmed",
          action: "attest",
          readinessSnapshotHash: priorHash,
        }),
        event({
          checkKey: "live_rehearsal_completed",
          action: "attest",
          readinessSnapshotHash: priorHash,
        }),
      ],
      currentHash,
      currentHash,
    );

    expect(state).toMatchObject({
      hoursConfirmed: false,
      otpPolicyConfirmed: false,
      liveRehearsalCompleted: false,
    });
    expect(allGoLivePrerequisitesConfirmed(state)).toBe(false);
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
      "d".repeat(64),
    );

    expect(state.ownerApproved).toBe(false);
    expect(state.ownerApprovalStale).toBe(false);
  });

  it("keeps sequential prerequisites current and supports config-change re-attestation", () => {
    const snapshotMaterial = {
      slug: "qa-salon",
      name: "QA Salon",
      address: "123 Main St",
      salonPhone: "+16045550123",
      timezone: "America/Vancouver",
      openingHours: {
        mon: { open: "09:00", close: "18:00", closed: false },
      },
      profileComplete: true,
      email: "owner@example.com",
      emailVerified: true,
      emailLinksEnabled: true,
      phoneOtpEnabled: true,
      activeServices: [
        { id: "service-1", priceCents: 4500, durationMinutes: 45 },
      ],
      activeStaffCount: 1,
      services: [
        { id: "service-1", priceCents: 4500, durationMinutes: 45 },
      ],
      activeStaffIds: ["staff-1"],
    };
    const technicalHash = createGoLiveReadinessSnapshotHash(snapshotMaterial);
    const hours = event({
      id: "hours-1",
      checkKey: "hours_confirmed",
      action: "attest",
      readinessSnapshotHash: technicalHash,
    });
    const otp = event({
      id: "otp-1",
      checkKey: "otp_policy_confirmed",
      action: "attest",
      readinessSnapshotHash: technicalHash,
    });
    const rehearsal = event({
      id: "rehearsal-1",
      checkKey: "live_rehearsal_completed",
      action: "attest",
      readinessSnapshotHash: technicalHash,
    });
    const prerequisites = [hours, otp, rehearsal];
    const approvalHash = createGoLiveApprovalSnapshotHash(
      technicalHash,
      prerequisites,
    );
    const owner = event({
      id: "owner-1",
      checkKey: "owner_approved",
      action: "attest",
      readinessSnapshotHash: approvalHash,
    });

    expect(
      deriveGoLiveAttestationState(
        [owner, ...prerequisites],
        technicalHash,
        approvalHash,
      ),
    ).toMatchObject({
      hoursConfirmed: true,
      otpPolicyConfirmed: true,
      liveRehearsalCompleted: true,
      ownerApproved: true,
      ownerApprovalStale: false,
    });

    const changedTechnicalHash = createGoLiveReadinessSnapshotHash({
      ...snapshotMaterial,
      openingHours: {
        mon: { open: "10:00", close: "18:00", closed: false },
      },
    });
    const changedApprovalHash = createGoLiveApprovalSnapshotHash(
      changedTechnicalHash,
      prerequisites,
    );
    expect(
      deriveGoLiveAttestationState(
        [owner, ...prerequisites],
        changedTechnicalHash,
        changedApprovalHash,
      ),
    ).toMatchObject({
      hoursConfirmed: false,
      otpPolicyConfirmed: false,
      liveRehearsalCompleted: false,
      ownerApproved: false,
      ownerApprovalStale: true,
    });

    const refreshedPrerequisites = prerequisites.map((prior, index) =>
      event({
        ...prior,
        id: `refreshed-${index + 1}`,
        readinessSnapshotHash: changedTechnicalHash,
      }),
    );
    const refreshedApprovalHash = createGoLiveApprovalSnapshotHash(
      changedTechnicalHash,
      refreshedPrerequisites,
    );
    const refreshedPrerequisiteState = deriveGoLiveAttestationState(
      [owner, ...refreshedPrerequisites],
      changedTechnicalHash,
      refreshedApprovalHash,
    );
    expect(refreshedPrerequisiteState).toMatchObject({
      hoursConfirmed: true,
      otpPolicyConfirmed: true,
      liveRehearsalCompleted: true,
      ownerApproved: false,
      ownerApprovalStale: true,
    });

    const refreshedOwner = event({
      id: "owner-2",
      checkKey: "owner_approved",
      action: "attest",
      readinessSnapshotHash: refreshedApprovalHash,
    });
    expect(
      deriveGoLiveAttestationState(
        [refreshedOwner, ...refreshedPrerequisites],
        changedTechnicalHash,
        refreshedApprovalHash,
      ),
    ).toMatchObject({
      hoursConfirmed: true,
      otpPolicyConfirmed: true,
      liveRehearsalCompleted: true,
      ownerApproved: true,
      ownerApprovalStale: false,
    });
  });
});
