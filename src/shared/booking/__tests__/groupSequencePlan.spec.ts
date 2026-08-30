import { describe, expect, it } from "vitest";

import {
  resolveGroupSequenceAvailability,
  validateGroupSequencePlan,
} from "@/shared/booking/groupSequencePlan";

const IDS = {
  salon: "10000000-0000-4000-8000-000000000001",
  group: "10000000-0000-4000-8000-000000000002",
  member0: "10000000-0000-4000-8000-000000000003",
  member1: "10000000-0000-4000-8000-000000000004",
  line0: "10000000-0000-4000-8000-000000000005",
  line1: "10000000-0000-4000-8000-000000000006",
  line2: "10000000-0000-4000-8000-000000000007",
  service0: "10000000-0000-4000-8000-000000000008",
  service1: "10000000-0000-4000-8000-000000000009",
  staff0: "10000000-0000-4000-8000-00000000000a",
  staff1: "10000000-0000-4000-8000-00000000000b",
  resource0: "10000000-0000-4000-8000-00000000000c",
  resource1: "10000000-0000-4000-8000-00000000000d",
};

function segment(args: {
  lineId: string;
  position: number;
  serviceId: string;
  staffId: string;
  resourceId: string | null;
  start: string;
  duration?: number;
  prep?: number;
  buffer?: number;
}) {
  const duration = args.duration ?? 60;
  const prep = args.prep ?? 0;
  const buffer = args.buffer ?? 0;
  const startMs = Date.parse(args.start);
  return {
    line_id: args.lineId,
    position: args.position,
    service_id: args.serviceId,
    resolved_staff_id: args.staffId,
    resolved_resource_id: args.resourceId,
    prep_minutes: prep,
    duration_minutes: duration,
    buffer_minutes: buffer,
    occupied_start_utc: new Date(startMs - prep * 60_000).toISOString(),
    service_start_utc: new Date(startMs).toISOString(),
    service_end_utc: new Date(startMs + duration * 60_000).toISOString(),
    occupied_end_utc: new Date(
      startMs + (duration + buffer) * 60_000,
    ).toISOString(),
  };
}

function validPlan() {
  return {
    contractVersion: 1,
    salonId: IDS.salon,
    groupRequestId: IDS.group,
    requestedAnchorUtc: "2030-06-15T10:00:00.000Z",
    seatTogether: false,
    members: [
      {
        memberIndex: 0,
        memberRequestId: IDS.member0,
        segments: [
          segment({
            lineId: IDS.line0,
            position: 0,
            serviceId: IDS.service0,
            staffId: IDS.staff0,
            resourceId: IDS.resource0,
            start: "2030-06-15T10:00:00.000Z",
          }),
          segment({
            lineId: IDS.line1,
            position: 1,
            serviceId: IDS.service1,
            staffId: IDS.staff1,
            resourceId: IDS.resource1,
            start: "2030-06-15T11:15:00.000Z",
            duration: 30,
          }),
        ],
      },
      {
        memberIndex: 1,
        memberRequestId: IDS.member1,
        segments: [
          segment({
            lineId: IDS.line2,
            position: 0,
            serviceId: IDS.service1,
            staffId: IDS.staff1,
            resourceId: IDS.resource1,
            start: "2030-06-15T10:00:00.000Z",
            duration: 45,
          }),
        ],
      },
    ],
  };
}

describe("group sequence plan", () => {
  it("accepts multiple guests with independent service sequences", () => {
    const result = validateGroupSequencePlan(validPlan());
    expect(result).toMatchObject({
      ok: true,
      summary: {
        memberCount: 2,
        serviceLineCount: 3,
        startSpreadMinutes: 0,
        totalCustomerWaitMinutes: 15,
      },
    });
  });

  it("rejects cross-member staff overlap that independent quotes miss", () => {
    const plan = validPlan();
    plan.members[1].segments[0].resolved_staff_id = IDS.staff0;
    const result = validateGroupSequencePlan(plan);
    expect(result).toMatchObject({
      ok: false,
      code: "staff_overlap",
      memberIndexes: [0, 1],
      resourceOrStaffId: IDS.staff0,
    });
  });

  it("finds a long overlap even when a same-member claim sits between it", () => {
    const plan = validPlan();
    plan.members[0].segments[0] = segment({
      lineId: IDS.line0,
      position: 0,
      serviceId: IDS.service0,
      staffId: IDS.staff0,
      resourceId: IDS.resource0,
      start: "2030-06-15T10:00:00.000Z",
      buffer: 60,
    });
    plan.members[0].segments[1].resolved_staff_id = IDS.staff0;
    plan.members[1].segments[0] = segment({
      lineId: IDS.line2,
      position: 0,
      serviceId: IDS.service1,
      staffId: IDS.staff0,
      resourceId: IDS.resource1,
      start: "2030-06-15T11:30:00.000Z",
      duration: 15,
    });
    expect(validateGroupSequencePlan(plan)).toMatchObject({
      ok: false,
      code: "staff_overlap",
      memberIndexes: [0, 1],
    });
  });

  it("rejects cross-member resource overlap", () => {
    const plan = validPlan();
    plan.members[1].segments[0].resolved_resource_id = IDS.resource0;
    const result = validateGroupSequencePlan(plan);
    expect(result).toMatchObject({ ok: false, code: "resource_overlap" });
  });

  it("does not claim sit-together without salon resource topology", () => {
    const plan = validPlan();
    plan.seatTogether = true;
    expect(validateGroupSequencePlan(plan)).toEqual({
      ok: false,
      code: "seat_together_unproven",
    });
    expect(
      validateGroupSequencePlan(plan, {
        adjacentResourceGroups: [[IDS.resource0, IDS.resource1]],
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects sit-together when first services start too far apart", () => {
    const plan = validPlan();
    plan.seatTogether = true;
    plan.members[1].segments[0] = segment({
      lineId: IDS.line2,
      position: 0,
      serviceId: IDS.service1,
      staffId: IDS.staff1,
      resourceId: IDS.resource1,
      start: "2030-06-15T10:45:00.000Z",
      duration: 15,
    });
    expect(
      validateGroupSequencePlan(plan, {
        adjacentResourceGroups: [[IDS.resource0, IDS.resource1]],
      }),
    ).toEqual({ ok: false, code: "arrival_spread_exceeded" });
  });

  it("requires both legacy gates, sequence readiness, and atomic commit", () => {
    expect(
      resolveGroupSequenceAvailability({
        groupBookingEnabled: true,
        multiServiceBookingEnabled: true,
        multiServiceReady: true,
        atomicGroupSequenceCommitReady: false,
      }),
    ).toEqual({ ready: false, reason: "atomic_commit_not_ready" });
    expect(
      resolveGroupSequenceAvailability({
        groupBookingEnabled: true,
        multiServiceBookingEnabled: true,
        multiServiceReady: true,
        atomicGroupSequenceCommitReady: true,
      }),
    ).toEqual({ ready: true });
  });

  it("fails closed for duplicate member idempotency identities", () => {
    const plan = validPlan();
    plan.members[1].memberRequestId = IDS.member0;
    expect(validateGroupSequencePlan(plan)).toEqual({
      ok: false,
      code: "duplicate_member_request",
    });
  });
});
