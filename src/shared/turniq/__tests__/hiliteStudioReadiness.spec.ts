import { describe, expect, it } from "vitest";

import type {
  TurnIqCandidateInput,
  TurnIqDecisionInput,
} from "@/shared/turniq/contracts";
import { decideSingleCustomer } from "@/shared/turniq/singleCustomerEngine";

const SERVICES = [
  ["hi-lite-classic", "Hi Lite Classic", 60, 8_500],
  ["hi-lite-deluxe", "Hi Lite Deluxe", 80, 12_500],
  ["hi-lite-royal", "Hi Lite Royal", 90, 15_500],
  ["hi-lite-special", "Hi Lite Special", 70, 10_500],
  ["hi-lite-vvip", "Hi Lite VVIP", 110, 19_500],
  ["collagen-eye-mask", "Collagen Eye Mask", 5, 500],
  ["hot-oil-treatment", "Hot Oil Treatment", 10, 2_000],
  ["hot-stone-addon", "Hot Stone Add-on", 5, 1_000],
  ["led-light-therapy-mask", "LED Light Therapy Mask", 15, 2_000],
  ["neck-shoulder-massage", "Neck / Shoulder Massage", 15, 2_000],
  ["premium-product-upgrade", "Premium Product Upgrade", 5, 1_000],
  ["scalp-exfoliation", "Scalp Exfoliation", 10, 2_000],
] as const;

const ALL_SERVICE_IDS = SERVICES.map(([serviceId]) => serviceId);

function candidate(
  position: number,
  overrides: Partial<TurnIqCandidateInput> = {},
): TurnIqCandidateInput {
  const suffix = String(position).padStart(2, "0");
  return {
    staffId: `hilite-qa-tech-${suffix}`,
    displayName: `Synthetic Tech ${suffix}`,
    stableStaffId: `hilite-qa-tech-${suffix}`,
    checkInSessionId: `hilite-qa-shift-${suffix}`,
    checkedInAt: `2026-09-02T15:0${position}:00.000Z`,
    queuePosition: position,
    checkedIn: true,
    active: true,
    busy: false,
    approvedBreak: false,
    temporaryHold: false,
    refusalPenaltyActive: false,
    manualSafetyHold: false,
    capabilityDataComplete: true,
    capableServiceIds: ALL_SERVICE_IDS,
    nextAppointmentStartsAt: null,
    serviceCreditSinceCheckInCents: 5_000 + (position - 1) * 500,
    fairnessBaselineCents: 0,
    ...overrides,
  };
}

function inputForService(
  service: (typeof SERVICES)[number],
  candidates: TurnIqCandidateInput[] = [1, 2, 3, 4].map((position) =>
    candidate(position),
  ),
): TurnIqDecisionInput {
  const [serviceId, serviceName, durationMinutes, catalogPriceCents] = service;
  return {
    policy: {
      policyId: "hilite-studio-qa-policy-v1",
      salonId: "hilite-studio-qa-synthetic",
      version: 1,
      name: "Hi-Lite Studio QA Money-Balanced Rotation",
      timezone: "America/Los_Angeles",
      effectiveBusinessDate: "2026-09-02",
      fairnessBandCents: 2_000,
      opportunityCreditStrategy:
        "catalog_plus_permitted_addons_before_tax_and_tip",
      lateArrivalBaselineStrategy: "median_eligible_team_credit_at_check_in",
      approvedBreakStrategy: "freeze_queue_position",
      unapprovedDepartureStrategy: "move_to_queue_end",
      unjustifiedRefusalStrategy: "move_to_queue_end",
      customerRejectionStrategy: "no_penalty",
      policyChangesDefaultToNextBusinessDay: true,
    },
    request: {
      requestId: `hilite-qa-request-${serviceId}`,
      salonId: "hilite-studio-qa-synthetic",
      bookingId: null,
      requestedStartAt: "2026-09-02T16:00:00.000Z",
      partySize: 1,
      serviceLines: [
        {
          lineId: `hilite-qa-line-${serviceId}`,
          serviceId,
          serviceName,
          catalogPriceCents,
          permittedAddonCents: 0,
          durationMinutes,
          bufferMinutes: 0,
          requiredResourceTypeIds: ["bed"],
        },
      ],
      requestedTechnician: null,
    },
    snapshot: {
      snapshotVersion: `hilite-qa-${serviceId}-v1`,
      capturedAt: "2026-09-02T15:59:00.000Z",
      businessDate: "2026-09-02",
      candidates,
      resources: Array.from({ length: 7 }, (_, index) => ({
        resourceId: `hilite-qa-bed-${index + 1}`,
        resourceTypeId: "bed",
        available: true,
      })),
    },
  };
}

describe("TurnIQ Hi-Lite Studio synthetic readiness", () => {
  it.each(SERVICES)(
    "recommends deterministically for %s (%s)",
    async (serviceId) => {
      const service = SERVICES.find(([id]) => id === serviceId);
      if (!service) throw new Error("hilite_qa_service_fixture_missing");

      const first = await decideSingleCustomer(inputForService(service));
      const second = await decideSingleCustomer(inputForService(service));

      expect(first.recommendedStaffId).toBe("hilite-qa-tech-01");
      expect(first.decisionReasonCodes).toContain("ELIGIBLE");
      expect(first.privacySafeExplanation).toContain("Synthetic Tech 01");
      expect(second.fingerprint).toBe(first.fingerprint);
      expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    },
  );

  it.each(SERVICES)(
    "protects the next appointment gap for %s (%s)",
    async (serviceId) => {
      const service = SERVICES.find(([id]) => id === serviceId);
      if (!service) throw new Error("hilite_qa_service_fixture_missing");
      const durationMinutes = service[2];
      const unsafeNextAppointment = new Date(
        Date.parse("2026-09-02T16:00:00.000Z") +
          (durationMinutes - 1) * 60_000,
      ).toISOString();
      const input = inputForService(service, [
        candidate(1, { nextAppointmentStartsAt: unsafeNextAppointment }),
        candidate(2),
      ]);

      const decision = await decideSingleCustomer(input);
      expect(decision.recommendedStaffId).toBe("hilite-qa-tech-02");
      expect(
        decision.candidates.find(
          (entry) => entry.staffId === "hilite-qa-tech-01",
        )?.reasonCodes,
      ).toContain("INSUFFICIENT_APPOINTMENT_GAP");
    },
  );

  it("fails closed when an add-on capability mapping is missing", async () => {
    const addon = SERVICES.find(([id]) => id === "collagen-eye-mask");
    if (!addon) throw new Error("hilite_qa_addon_fixture_missing");
    const input = inputForService(
      addon,
      [1, 2, 3, 4].map((position) =>
        candidate(position, {
          capableServiceIds: ALL_SERVICE_IDS.filter(
            (serviceId) => serviceId !== "collagen-eye-mask",
          ),
        }),
      ),
    );

    const decision = await decideSingleCustomer(input);
    expect(decision.recommendedStaffId).toBeNull();
    expect(decision.decisionReasonCodes).toContain("NO_ELIGIBLE_CANDIDATE");
    expect(decision.candidates.every((entry) =>
      entry.reasonCodes.includes("SKILL_MISMATCH"),
    )).toBe(true);
  });
});
