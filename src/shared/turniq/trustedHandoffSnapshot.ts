import type {
  TurnIqCandidateInput,
  TurnIqHandoffDecisionInput,
  TurnIqHandoffResourceAvailability,
  TurnIqPolicyVersion,
  TurnIqServiceLine,
} from "@/shared/turniq/contracts";
import { canonicalTurnIqJson, sha256TurnIqHex } from "@/shared/turniq/fingerprint";
import { TurnIqContractError } from "@/shared/turniq/singleCustomerEngine";
import type {
  TurnIqTrustedCapability,
  TurnIqTrustedOccupiedBooking,
  TurnIqTrustedShift,
  TurnIqTrustedStaff,
} from "@/shared/turniq/trustedSnapshot";

export type TurnIqTrustedHandoffBooking = {
  id: string;
  salonId: string;
  status: "pending" | "confirmed" | "waiting";
  scheduleModel: string;
};

export type TurnIqTrustedHandoffAddon = {
  serviceId: string;
  name: string;
  priceCents: number;
  durationMinutes: number;
};

export type TurnIqTrustedHandoffSegment = {
  id: string;
  bookingId: string;
  position: number;
  serviceId: string;
  serviceName: string;
  staffId: string;
  resourceId: string | null;
  customerStartAt: string;
  customerEndAt: string;
  occupiedStartAt: string;
  occupiedEndAt: string;
  serviceDurationMinutes: number;
  sequentialAddonMinutes: number;
  trailingBufferMinutes: number;
  originalServicePriceCents: number;
  addonPreVoucherCents: number;
  addonLines: readonly TurnIqTrustedHandoffAddon[];
};

export type TurnIqTrustedHandoffResource = {
  id: string;
  kind: string;
  active: boolean;
  sameGuestParallelCapacity: number;
};

export type TurnIqTrustedParallelPolicy = {
  id: string;
  serviceAId: string;
  serviceBId: string;
  resourceMode: "shared" | "distinct" | "either";
  active: boolean;
};

export type TurnIqTrustedHandoffSnapshotSource = {
  salonId: string;
  capturedAt: string;
  businessDate: string;
  policy: TurnIqPolicyVersion;
  booking: TurnIqTrustedHandoffBooking;
  segments: readonly TurnIqTrustedHandoffSegment[];
  staff: readonly TurnIqTrustedStaff[];
  shifts: readonly TurnIqTrustedShift[];
  capabilities: readonly TurnIqTrustedCapability[] | null;
  occupiedBookings: readonly (TurnIqTrustedOccupiedBooking & {
    bookingId: string | null;
  })[];
  resources: readonly TurnIqTrustedHandoffResource[];
  parallelPolicies: readonly TurnIqTrustedParallelPolicy[];
};

export type TurnIqTrustedHandoffDecisionInput = {
  decisionInput: TurnIqHandoffDecisionInput;
  shiftSessionByStaffId: ReadonlyMap<string, string>;
  committedStaffBySegmentId: ReadonlyMap<string, string>;
};

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function millis(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TurnIqContractError(code);
  return parsed;
}

function overlaps(
  leftStart: string,
  leftEnd: string,
  rightStart: string,
  rightEnd: string,
): boolean {
  return millis(leftStart, "turniq_invalid_handoff_window") <
      millis(rightEnd, "turniq_invalid_handoff_window") &&
    millis(rightStart, "turniq_invalid_handoff_window") <
      millis(leftEnd, "turniq_invalid_handoff_window");
}

function pairKey(left: string, right: string): string {
  return [left, right].sort(compareText).join(":");
}

function validateCommittedParallelPolicy(
  source: TurnIqTrustedHandoffSnapshotSource,
): void {
  const resources = new Map(source.resources.map((resource) => [resource.id, resource]));
  const policies = new Map(
    source.parallelPolicies
      .filter((policy) => policy.active)
      .map((policy) => [pairKey(policy.serviceAId, policy.serviceBId), policy]),
  );
  for (let leftIndex = 0; leftIndex < source.segments.length; leftIndex += 1) {
    const left = source.segments[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < source.segments.length; rightIndex += 1) {
      const right = source.segments[rightIndex];
      if (!overlaps(left.customerStartAt, left.customerEndAt, right.customerStartAt, right.customerEndAt)) {
        continue;
      }
      const policy = policies.get(pairKey(left.serviceId, right.serviceId));
      if (!policy || left.staffId === right.staffId) {
        throw new TurnIqContractError("turniq_handoff_parallel_policy_missing");
      }
      const shared = left.resourceId !== null && left.resourceId === right.resourceId;
      if (
        (shared && !["shared", "either"].includes(policy.resourceMode)) ||
        (!shared && !["distinct", "either"].includes(policy.resourceMode))
      ) {
        throw new TurnIqContractError("turniq_handoff_parallel_resource_mode_mismatch");
      }
      if (shared) {
        const resource = resources.get(left.resourceId as string);
        const concurrentCount = source.segments.filter(
          (segment) =>
            segment.resourceId === left.resourceId &&
            overlaps(
              segment.customerStartAt,
              segment.customerEndAt,
              left.customerStartAt,
              left.customerEndAt,
            ),
        ).length;
        if (!resource || !resource.active || resource.sameGuestParallelCapacity < concurrentCount) {
          throw new TurnIqContractError("turniq_handoff_shared_resource_capacity_exceeded");
        }
      }
    }
  }
}

function serviceLines(
  segment: TurnIqTrustedHandoffSegment,
  resourceKind: string | null,
): TurnIqServiceLine[] {
  const addonTotal = segment.addonLines.reduce((total, addon) => total + addon.priceCents, 0);
  if (addonTotal !== segment.addonPreVoucherCents) {
    throw new TurnIqContractError("turniq_handoff_addon_credit_mismatch");
  }
  return [
    {
      lineId: `${segment.id}:service`,
      serviceId: segment.serviceId,
      serviceName: segment.serviceName,
      catalogPriceCents: segment.originalServicePriceCents,
      permittedAddonCents: 0,
      durationMinutes: segment.serviceDurationMinutes,
      bufferMinutes: segment.trailingBufferMinutes,
      requiredResourceTypeIds: resourceKind ? [resourceKind] : [],
    },
    ...segment.addonLines.map((addon) => ({
      lineId: `${segment.id}:addon:${addon.serviceId}`,
      serviceId: addon.serviceId,
      serviceName: addon.name,
      catalogPriceCents: 0,
      permittedAddonCents: addon.priceCents,
      durationMinutes: Math.max(1, addon.durationMinutes),
      bufferMinutes: 0,
      requiredResourceTypeIds: resourceKind ? [resourceKind] : [],
    })),
  ];
}

/** Builds the deterministic M4Q input only from server-owned, salon-scoped rows. */
export async function buildTrustedTurnIqHandoffDecisionInput(
  source: TurnIqTrustedHandoffSnapshotSource,
): Promise<TurnIqTrustedHandoffDecisionInput> {
  if (
    source.salonId !== source.policy.salonId ||
    source.salonId !== source.booking.salonId ||
    source.booking.scheduleModel !== "segments_v1" ||
    !(["pending", "confirmed", "waiting"] as const).includes(source.booking.status) ||
    source.segments.length < 2 ||
    source.segments.length > 5 ||
    source.segments.some((segment) => segment.bookingId !== source.booking.id)
  ) {
    throw new TurnIqContractError("turniq_trusted_handoff_source_invalid");
  }
  validateCommittedParallelPolicy(source);

  const resourceMap = new Map(source.resources.map((resource) => [resource.id, resource]));
  const shifts = new Map<string, TurnIqTrustedShift>();
  for (const shift of source.shifts) {
    if (shifts.has(shift.staffId)) {
      throw new TurnIqContractError("turniq_duplicate_open_shift");
    }
    shifts.set(shift.staffId, shift);
  }
  const capabilityMap = source.capabilities?.reduce((map, row) => {
    const values = map.get(row.staffId) ?? new Set<string>();
    values.add(row.serviceId);
    map.set(row.staffId, values);
    return map;
  }, new Map<string, Set<string>>()) ?? null;
  const externalOccupancy = source.occupiedBookings.filter(
    (row) => row.bookingId !== source.booking.id,
  );
  const capturedAtMs = millis(source.capturedAt, "turniq_invalid_snapshot_timestamp");
  const candidates: TurnIqCandidateInput[] = [...source.staff]
    .sort((left, right) => compareText(left.id, right.id))
    .map((staff, index) => {
      const shift = shifts.get(staff.id);
      const busyWindows = externalOccupancy
        .filter((row) => row.staffId === staff.id)
        .sort((left, right) => millis(left.startAt, "turniq_invalid_occupied_start") - millis(right.startAt, "turniq_invalid_occupied_start"));
      const current = busyWindows.find(
        (row) => millis(row.startAt, "turniq_invalid_occupied_start") <= capturedAtMs && millis(row.endAt, "turniq_invalid_occupied_end") > capturedAtMs,
      );
      const checkedIn = Boolean(
        shift &&
        shift.policyVersionId === source.policy.policyId &&
        shift.businessDate === source.businessDate &&
        shift.state !== "checked_out",
      );
      return {
        staffId: staff.id,
        displayName: staff.name,
        stableStaffId: staff.id,
        checkInSessionId: shift?.id ?? `missing:${staff.id}`,
        checkedInAt: shift?.checkedInAt ?? source.capturedAt,
        queuePosition: shift?.queuePosition ?? source.shifts.length + index + 1,
        checkedIn,
        active: staff.active && checkedIn,
        busy: Boolean(current),
        approvedBreak: shift?.state === "approved_break",
        temporaryHold: shift?.state === "temporary_hold",
        refusalPenaltyActive: false,
        manualSafetyHold: false,
        capabilityDataComplete: capabilityMap !== null,
        capableServiceIds: capabilityMap ? [...(capabilityMap.get(staff.id) ?? [])].sort(compareText) : [],
        nextAppointmentStartsAt: null,
        serviceCreditSinceCheckInCents: shift?.serviceCreditSinceCheckInCents ?? 0,
        fairnessBaselineCents: shift?.fairnessBaselineCents ?? 0,
      };
    });

  const policyMaterial = {
    resources: source.resources.map((resource) => ({
      id: resource.id,
      capacity: resource.sameGuestParallelCapacity,
      active: resource.active,
    })).sort((left, right) => compareText(left.id, right.id)),
    policies: source.parallelPolicies.map((policy) => ({ ...policy })).sort((left, right) => compareText(left.id, right.id)),
  };
  const policyFingerprint = await sha256TurnIqHex(canonicalTurnIqJson(policyMaterial));
  const resources: TurnIqHandoffResourceAvailability[] = source.resources
    .filter((resource) => resource.active)
    .sort((left, right) => compareText(left.id, right.id))
    .map((resource) => ({
      resourceId: resource.id,
      resourceTypeId: resource.kind,
      available: !externalOccupancy.some(
        (row) =>
          row.resourceId === resource.id &&
          source.segments.some((segment) =>
            overlaps(row.startAt, row.endAt, segment.occupiedStartAt, segment.occupiedEndAt),
          ),
      ),
      availableAt: source.capturedAt,
      sameCustomerParallelCapacity: resource.sameGuestParallelCapacity,
      policyFingerprint,
    }));
  const segments = [...source.segments]
    .sort((left, right) => left.position - right.position || compareText(left.id, right.id))
    .map((segment) => {
      const resource = segment.resourceId ? resourceMap.get(segment.resourceId) : null;
      if (segment.resourceId && (!resource || !resource.active)) {
        throw new TurnIqContractError("turniq_handoff_resource_unavailable");
      }
      return {
        segmentId: segment.id,
        serviceLines: serviceLines(segment, resource?.kind ?? null),
        startsAt: segment.occupiedStartAt,
        releasesAt: segment.occupiedEndAt,
        resourceId: segment.resourceId,
        // The legacy booking boolean cannot prove who captured the request.
        // Preserve no claim rather than inventing provenance.
        requestedTechnician: null,
      };
    });
  const staffAvailability = candidates.map((candidate) => ({
    staffId: candidate.staffId,
    availableAt: source.capturedAt,
    busyWindows: externalOccupancy
      .filter((row) => row.staffId === candidate.staffId)
      .map((row) => ({ startsAt: row.startAt, releasesAt: row.endAt })),
  }));
  const snapshotVersion = await sha256TurnIqHex(
    canonicalTurnIqJson({
      source: "trusted_server_handoff_snapshot_v1",
      salonId: source.salonId,
      businessDate: source.businessDate,
      capturedAt: source.capturedAt,
      policyId: source.policy.policyId,
      bookingId: source.booking.id,
      segments,
      candidates,
      staffAvailability,
      resources,
      policyFingerprint,
    }),
  );
  return {
    decisionInput: {
      policy: source.policy,
      request: {
        requestId: source.booking.id,
        salonId: source.salonId,
        bookingId: source.booking.id,
        segments,
      },
      snapshot: {
        snapshotVersion,
        capturedAt: source.capturedAt,
        businessDate: source.businessDate,
        candidates,
        staffAvailability,
        resources,
      },
    },
    shiftSessionByStaffId: new Map(
      source.shifts.map((shift) => [shift.staffId, shift.id]),
    ),
    committedStaffBySegmentId: new Map(
      source.segments.map((segment) => [segment.id, segment.staffId]),
    ),
  };
}
