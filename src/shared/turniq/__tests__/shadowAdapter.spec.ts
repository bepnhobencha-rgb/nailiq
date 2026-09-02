import { describe, expect, it } from "vitest";

import type { ReceptionistCenterData } from "@/shared/dashboard/loadReceptionistCenterData";
import type { TurnIqAssignmentRequest } from "@/shared/turniq/contracts";
import { salonATurnPolicyFixture } from "@/shared/turniq/fixtures/salonA";
import {
  buildTurnIqShadowDecisionInput,
  type TurnIqReceptionistShadowSource,
} from "@/shared/turniq/shadowAdapter";

function receptionistData(): ReceptionistCenterData {
  return {
    observedAtIso: "2026-09-02T17:00:00.000Z",
    salon: {
      id: "turniq-salon-a",
      name: "Synthetic Salon",
      slug: "synthetic-salon",
      timezone: "America/Vancouver",
    },
    staff: [
      {
        id: "turniq-staff-01",
        name: "Tech 01",
        job_role: "nail_tech",
        status: "available",
        workload: 25,
      },
      {
        id: "turniq-staff-02",
        name: "Tech 02",
        job_role: "nail_tech",
        status: "available",
        workload: 50,
      },
    ],
    bookingsForDay: [
      {
        id: "future-booking",
        staff_id: "turniq-staff-01",
        start_time_utc: "2026-09-02T18:30:00.000Z",
        end_time_utc: "2026-09-02T19:30:00.000Z",
        status: "confirmed",
        client_name: "Private Customer",
        client_phone: "+15555550100",
      },
    ],
    capabilityRows: [
      { staff_id: "turniq-staff-01", service_id: "deluxe-pedicure" },
      { staff_id: "turniq-staff-02", service_id: "deluxe-pedicure" },
    ],
    selectedDate: "2026-09-02",
  } as unknown as ReceptionistCenterData;
}

const request: TurnIqAssignmentRequest = {
  requestId: "shadow-request-1",
  salonId: "turniq-salon-a",
  bookingId: null,
  requestedStartAt: "2026-09-02T17:30:00.000Z",
  partySize: 1,
  serviceLines: [
    {
      lineId: "line-1",
      serviceId: "deluxe-pedicure",
      serviceName: "Deluxe Pedicure",
      catalogPriceCents: 6_000,
      permittedAddonCents: 1_000,
      durationMinutes: 50,
      bufferMinutes: 10,
      requiredResourceTypeIds: ["pedicure-chair"],
    },
  ],
  requestedTechnician: null,
};

function source(): TurnIqReceptionistShadowSource {
  return {
    data: receptionistData(),
    policy: structuredClone(salonATurnPolicyFixture),
    request: structuredClone(request),
    shiftStates: [
      {
        staffId: "turniq-staff-01",
        checkInSessionId: "shift-1",
        checkedInAt: "2026-09-02T15:00:00.000Z",
        queuePosition: 1,
        state: "active",
        refusalPenaltyActive: false,
        manualSafetyHold: false,
        serviceCreditSinceCheckInCents: 2_000,
        fairnessBaselineCents: 4_000,
      },
    ],
    resources: [
      {
        resourceId: "chair-1",
        resourceTypeId: "pedicure-chair",
        available: true,
      },
    ],
  };
}

describe("TurnIQ Receptionist Center shadow adapter", () => {
  it("maps current desk state without treating missing check-in as active", async () => {
    const input = await buildTurnIqShadowDecisionInput(source());
    const first = input.snapshot.candidates.find(
      (candidate) => candidate.staffId === "turniq-staff-01",
    );
    const second = input.snapshot.candidates.find(
      (candidate) => candidate.staffId === "turniq-staff-02",
    );
    expect(first).toMatchObject({
      checkedIn: true,
      active: true,
      queuePosition: 1,
      capableServiceIds: ["deluxe-pedicure"],
      nextAppointmentStartsAt: "2026-09-02T18:30:00.000Z",
    });
    expect(second).toMatchObject({
      checkedIn: false,
      active: false,
      capabilityDataComplete: true,
    });
    expect(input.snapshot.snapshotVersion).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails capability eligibility closed when Receptionist Center has legacy fallback", async () => {
    const value = source();
    value.data.capabilityRows = null;
    const input = await buildTurnIqShadowDecisionInput(value);
    expect(
      input.snapshot.candidates.every(
        (candidate) => !candidate.capabilityDataComplete,
      ),
    ).toBe(true);
  });

  it("does not fingerprint customer name or phone and does not mutate source", async () => {
    const original = source();
    const before = structuredClone(original);
    const first = await buildTurnIqShadowDecisionInput(original);
    const changedPii = source();
    changedPii.data.bookingsForDay[0].client_name = "Different Customer";
    changedPii.data.bookingsForDay[0].client_phone = "+15555550999";
    const second = await buildTurnIqShadowDecisionInput(changedPii);
    expect(second.snapshot.snapshotVersion).toBe(first.snapshot.snapshotVersion);
    expect(original).toEqual(before);
  });

  it("rejects a cross-salon source before producing a shadow snapshot", async () => {
    const value = source();
    value.request.salonId = "other-salon";
    await expect(buildTurnIqShadowDecisionInput(value)).rejects.toMatchObject({
      code: "turniq_shadow_cross_salon_source",
    });
  });
});
