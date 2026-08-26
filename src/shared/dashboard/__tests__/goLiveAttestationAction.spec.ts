import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  getDashboardWriteClient: vi.fn(),
  loadGoLiveReadiness: vi.fn(),
  loadGuidedBookingPreviewAvailability: vi.fn(),
  createServiceRoleClient: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/shared/dashboard/setupActions", () => ({
  getDashboardWriteClient: mocks.getDashboardWriteClient,
}));
vi.mock("@/shared/dashboard/loadGoLiveReadiness", () => ({
  loadGoLiveReadiness: mocks.loadGoLiveReadiness,
}));
vi.mock("@/shared/dashboard/loadGuidedBookingPreviewAvailability", () => ({
  loadGuidedBookingPreviewAvailability:
    mocks.loadGuidedBookingPreviewAvailability,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

import { recordGoLiveAttestation } from "@/shared/dashboard/goLiveAttestationAction";

const guidedPreviewSelection = {
  serviceId: "service-1",
  staffId: "any",
  dateYmd: "2026-09-03",
  timeLabel: "9:00 AM",
};
const guidedPreviewEvidenceNote =
  "Owner reviewed the safe booking preview.\n" +
  '[guided-preview:{"serviceId":"service-1","staffId":"any","dateYmd":"2026-09-03","timeLabel":"9:00 AM"}]';
const guidedPreviewEvent = {
  checkKey: "live_rehearsal_completed",
  action: "attest",
  evidenceNote: guidedPreviewEvidenceNote,
};

function readiness(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    guidedSetupEnabled: true,
    technicalSnapshotHash: "technical-current",
    snapshotHash: "approval-current",
    latestAttestationEvents: [],
    attestationState: {
      hoursConfirmed: true,
      otpPolicyConfirmed: true,
      liveRehearsalCompleted: true,
      ownerApproved: false,
      ownerApprovalStale: false,
    },
    readiness: {
      readyForManualReview: true,
      checks: [{ id: "schedule", state: "pass" }],
    },
    ...overrides,
  };
}

describe("recordGoLiveAttestation guided preview boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDashboardWriteClient.mockResolvedValue({
      kind: "member",
      role: "owner",
      userId: "owner-1",
      salon: { id: "salon-1", slug: "qa-salon" },
    });
    mocks.loadGoLiveReadiness.mockResolvedValue(readiness());
    mocks.loadGuidedBookingPreviewAvailability.mockResolvedValue({
      ok: true,
      dateYmd: "2026-09-03",
      slots: [{ label: "9:00 AM", available: true }],
    });
    mocks.insert.mockResolvedValue({ error: null });
    mocks.createServiceRoleClient.mockReturnValue({
      from: vi.fn(() => ({ insert: mocks.insert })),
    });
  });

  it("refuses a guided rehearsal attestation when the safe preview is unavailable", async () => {
    mocks.loadGuidedBookingPreviewAvailability.mockResolvedValue({
      ok: false,
      reason: "unavailable",
    });

    await expect(
      recordGoLiveAttestation("qa-salon", {
        checkKey: "live_rehearsal_completed",
        action: "attest",
        evidenceNote: "Owner reviewed the safe booking preview.",
        guidedPreviewSelection,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "guided_preview_unavailable",
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("rejects a Guided rehearsal click without an exact availability selection", async () => {
    await expect(
      recordGoLiveAttestation("qa-salon", {
        checkKey: "live_rehearsal_completed",
        action: "attest",
        evidenceNote: "Owner reviewed the safe booking preview.",
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_input" });
    expect(mocks.loadGuidedBookingPreviewAvailability).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("records a guided rehearsal only against the current technical snapshot", async () => {
    await expect(
      recordGoLiveAttestation("qa-salon", {
        checkKey: "live_rehearsal_completed",
        action: "attest",
        evidenceNote: "Owner reviewed the safe booking preview.",
        guidedPreviewSelection,
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.loadGuidedBookingPreviewAvailability).toHaveBeenCalledWith({
      slug: "qa-salon",
      serviceId: "service-1",
      staffId: "any",
      dateYmd: "2026-09-03",
    });
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        salon_id: "salon-1",
        check_key: "live_rehearsal_completed",
        action: "attest",
        readiness_snapshot_hash: "technical-current",
        actor_user_id: "owner-1",
        actor_role: "owner",
        evidence_note:
          "Owner reviewed the safe booking preview.\n" +
          '[guided-preview:{"serviceId":"service-1","staffId":"any","dateYmd":"2026-09-03","timeLabel":"9:00 AM"}]',
      }),
    );
  });

  it("rejects a selected slot that is no longer available", async () => {
    mocks.loadGuidedBookingPreviewAvailability.mockResolvedValue({
      ok: true,
      dateYmd: "2026-09-03",
      slots: [{ label: "9:00 AM", available: false }],
    });
    await expect(
      recordGoLiveAttestation("qa-salon", {
        checkKey: "live_rehearsal_completed",
        action: "attest",
        evidenceNote: "Owner reviewed the selected availability.",
        guidedPreviewSelection,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "guided_preview_unavailable",
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("rejects evidence that would exceed the persisted audit limit", async () => {
    await expect(
      recordGoLiveAttestation("qa-salon", {
        checkKey: "live_rehearsal_completed",
        action: "attest",
        evidenceNote: "A".repeat(500),
        guidedPreviewSelection,
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_input" });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("requires the same strict availability proof for final owner approval", async () => {
    mocks.loadGoLiveReadiness.mockResolvedValue(
      readiness({ latestAttestationEvents: [guidedPreviewEvent] }),
    );
    mocks.loadGuidedBookingPreviewAvailability.mockResolvedValue({
      ok: false,
      reason: "unavailable",
    });

    await expect(
      recordGoLiveAttestation("qa-salon", {
        checkKey: "owner_approved",
        action: "attest",
        evidenceNote: "Owner approves the current configuration snapshot.",
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "guided_preview_unavailable",
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("records final owner approval against the prerequisite-bound approval snapshot", async () => {
    mocks.loadGoLiveReadiness.mockResolvedValue(
      readiness({ latestAttestationEvents: [guidedPreviewEvent] }),
    );
    await expect(
      recordGoLiveAttestation("qa-salon", {
        checkKey: "owner_approved",
        action: "attest",
        evidenceNote: "Owner approves the current configuration snapshot.",
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        check_key: "owner_approved",
        readiness_snapshot_hash: "approval-current",
      }),
    );
    expect(mocks.loadGuidedBookingPreviewAvailability).toHaveBeenCalledWith({
      slug: "qa-salon",
      serviceId: "service-1",
      staffId: "any",
      dateYmd: "2026-09-03",
    });
  });

  it("rejects final approval when the durable rehearsal selection is missing or malformed", async () => {
    for (const latestAttestationEvents of [
      [],
      [{ ...guidedPreviewEvent, evidenceNote: "Human note only" }],
      [{ ...guidedPreviewEvent, action: "revoke" }],
    ]) {
      mocks.loadGoLiveReadiness.mockResolvedValue(
        readiness({ latestAttestationEvents }),
      );
      await expect(
        recordGoLiveAttestation("qa-salon", {
          checkKey: "owner_approved",
          action: "attest",
          evidenceNote: "Owner approves the current configuration snapshot.",
        }),
      ).resolves.toEqual({
        ok: false,
        reason: "guided_preview_unavailable",
      });
    }
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("allows a stale prerequisite with the same latest action to be re-attested", async () => {
    mocks.loadGoLiveReadiness.mockResolvedValue(
      readiness({
        latestAttestationEvents: [
          {
            checkKey: "hours_confirmed",
            action: "attest",
          },
        ],
        attestationState: {
          hoursConfirmed: false,
          otpPolicyConfirmed: true,
          liveRehearsalCompleted: true,
          ownerApproved: false,
          ownerApprovalStale: true,
        },
      }),
    );

    await expect(
      recordGoLiveAttestation("qa-salon", {
        checkKey: "hours_confirmed",
        action: "attest",
        evidenceNote: "Owner rechecked hours after the schedule changed.",
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        check_key: "hours_confirmed",
        readiness_snapshot_hash: "technical-current",
      }),
    );
  });

  it("keeps a current prerequisite attestation idempotent", async () => {
    mocks.loadGoLiveReadiness.mockResolvedValue(
      readiness({
        latestAttestationEvents: [
          {
            checkKey: "hours_confirmed",
            action: "attest",
          },
        ],
      }),
    );

    await expect(
      recordGoLiveAttestation("qa-salon", {
        checkKey: "hours_confirmed",
        action: "attest",
        evidenceNote: "Owner rechecked the current schedule configuration.",
      }),
    ).resolves.toEqual({ ok: true, unchanged: true });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("allows a safety revocation even when the preview is unavailable", async () => {
    mocks.loadGoLiveReadiness.mockResolvedValue(
      readiness({
        latestAttestationEvents: [
          {
            checkKey: "live_rehearsal_completed",
            action: "attest",
          },
        ],
      }),
    );

    await expect(
      recordGoLiveAttestation("qa-salon", {
        checkKey: "live_rehearsal_completed",
        action: "revoke",
        evidenceNote: "Owner revoked the prior preview review proof.",
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.loadGuidedBookingPreviewAvailability).not.toHaveBeenCalled();
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        check_key: "live_rehearsal_completed",
        action: "revoke",
      }),
    );
  });

  it("does not require Guided preview availability for a legacy salon", async () => {
    mocks.loadGoLiveReadiness.mockResolvedValue(
      readiness({ guidedSetupEnabled: false }),
    );

    await expect(
      recordGoLiveAttestation("qa-salon", {
        checkKey: "owner_approved",
        action: "attest",
        evidenceNote: "Owner approves the legacy readiness snapshot.",
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.loadGuidedBookingPreviewAvailability).not.toHaveBeenCalled();
  });
});
