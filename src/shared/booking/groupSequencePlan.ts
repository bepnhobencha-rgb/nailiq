import { intervalsOverlapMs } from "@/shared/booking/bookingIntervals";
import {
  canonicalizeUtcInstant,
  parseSequenceTimingSegments,
  type SequenceTimingSegment,
} from "@/shared/booking/bookingSequence";

export const GROUP_SEQUENCE_MIN_MEMBERS = 2;
export const GROUP_SEQUENCE_MAX_MEMBERS = 20;
export const GROUP_SEQUENCE_MAX_TOTAL_LINES = 40;
export const GROUP_SEQUENCE_CONTRACT_VERSION = 1;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type GroupSequenceMemberPlan = {
  memberIndex: number;
  memberRequestId: string;
  segments: SequenceTimingSegment[];
};

export type GroupSequencePlan = {
  contractVersion: 1;
  salonId: string;
  groupRequestId: string;
  requestedAnchorUtc: string;
  seatTogether: boolean;
  members: GroupSequenceMemberPlan[];
};

export type GroupSequencePlanSummary = {
  groupStartUtc: string;
  groupEndUtc: string;
  startSpreadMinutes: number;
  finishSpreadMinutes: number;
  totalCustomerWaitMinutes: number;
  memberCount: number;
  serviceLineCount: number;
};

export type GroupSequencePlanFailureCode =
  | "invalid_contract"
  | "invalid_identity"
  | "invalid_member_count"
  | "invalid_member_order"
  | "duplicate_member_request"
  | "invalid_member_segments"
  | "too_many_service_lines"
  | "staff_overlap"
  | "resource_overlap"
  | "arrival_spread_exceeded"
  | "seat_together_unproven";

export type GroupSequencePlanValidation =
  | { ok: true; plan: GroupSequencePlan; summary: GroupSequencePlanSummary }
  | {
      ok: false;
      code: GroupSequencePlanFailureCode;
      memberIndexes?: [number, number];
      resourceOrStaffId?: string;
    };

export type GroupSequenceReadiness = {
  groupBookingEnabled: boolean;
  multiServiceBookingEnabled: boolean;
  multiServiceReady: boolean;
  atomicGroupSequenceCommitReady: boolean;
  groupSequenceManagementReady: boolean;
};

export type GroupSequenceAvailability =
  | { ready: true }
  | {
      ready: false;
      reason:
        | "group_booking_disabled"
        | "multi_service_booking_disabled"
        | "multi_service_not_ready"
        | "atomic_commit_not_ready"
        | "management_lifecycle_not_ready";
    };

type OccupiedClaim = {
  memberIndex: number;
  claimId: string;
  startMs: number;
  endMs: number;
};

function uuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return UUID_RE.test(normalized) ? normalized : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const allowed = new Set(required);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function parseMemberPlan(
  value: unknown,
  expectedIndex: number,
): GroupSequenceMemberPlan | null {
  if (
    !record(value) ||
    !exactKeys(value, ["memberIndex", "memberRequestId", "segments"]) ||
    value.memberIndex !== expectedIndex
  ) {
    return null;
  }
  const memberRequestId = uuid(value.memberRequestId);
  const segments = parseSequenceTimingSegments(value.segments);
  if (!memberRequestId || !segments) return null;
  return { memberIndex: expectedIndex, memberRequestId, segments };
}

function claimsOverlap(claims: OccupiedClaim[]): [OccupiedClaim, OccupiedClaim] | null {
  const ordered = claims.slice().sort((left, right) => {
    if (left.claimId !== right.claimId) return left.claimId.localeCompare(right.claimId);
    if (left.startMs !== right.startMs) return left.startMs - right.startMs;
    return left.memberIndex - right.memberIndex;
  });
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    const left = ordered[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
      const right = ordered[rightIndex];
      if (left.claimId !== right.claimId) break;
      if (
        left.memberIndex !== right.memberIndex &&
        intervalsOverlapMs(left.startMs, left.endMs, right.startMs, right.endMs)
      ) {
        return [left, right];
      }
    }
  }
  return null;
}

function adjacentResourceSet(
  groups: readonly (readonly string[])[],
  resourceIds: readonly string[],
): boolean {
  return groups.some((group) => {
    const normalized = new Set(group.map((value) => uuid(value)).filter(Boolean));
    return resourceIds.every((resourceId) => normalized.has(resourceId));
  });
}

export function resolveGroupSequenceAvailability(
  readiness: GroupSequenceReadiness,
): GroupSequenceAvailability {
  if (!readiness.groupBookingEnabled) {
    return { ready: false, reason: "group_booking_disabled" };
  }
  if (!readiness.multiServiceBookingEnabled) {
    return { ready: false, reason: "multi_service_booking_disabled" };
  }
  if (!readiness.multiServiceReady) {
    return { ready: false, reason: "multi_service_not_ready" };
  }
  if (!readiness.atomicGroupSequenceCommitReady) {
    return { ready: false, reason: "atomic_commit_not_ready" };
  }
  if (!readiness.groupSequenceManagementReady) {
    return { ready: false, reason: "management_lifecycle_not_ready" };
  }
  return { ready: true };
}

/**
 * Strict proof boundary for a quoted group × multi-service plan.
 *
 * Individual sequence quotes are not enough: two independently valid quotes
 * can still claim the same staff member or bed at the same time. This validator
 * rejects that cross-member collision and refuses to claim "sit together"
 * unless the caller supplies salon-owned resource adjacency evidence.
 *
 * It does not persist bookings. Runtime callers must keep the feature OFF until
 * one database transaction can commit every member and segment idempotently.
 */
export function validateGroupSequencePlan(
  value: unknown,
  options: {
    adjacentResourceGroups?: readonly (readonly string[])[];
    maxSeatTogetherStartSpreadMinutes?: number;
  } = {},
): GroupSequencePlanValidation {
  if (
    !record(value) ||
    !exactKeys(value, [
      "contractVersion",
      "salonId",
      "groupRequestId",
      "requestedAnchorUtc",
      "seatTogether",
      "members",
    ]) ||
    value.contractVersion !== GROUP_SEQUENCE_CONTRACT_VERSION ||
    typeof value.seatTogether !== "boolean"
  ) {
    return { ok: false, code: "invalid_contract" };
  }
  const salonId = uuid(value.salonId);
  const groupRequestId = uuid(value.groupRequestId);
  const requestedAnchorUtc = canonicalizeUtcInstant(value.requestedAnchorUtc);
  if (!salonId || !groupRequestId || !requestedAnchorUtc) {
    return { ok: false, code: "invalid_identity" };
  }
  if (
    !Array.isArray(value.members) ||
    value.members.length < GROUP_SEQUENCE_MIN_MEMBERS ||
    value.members.length > GROUP_SEQUENCE_MAX_MEMBERS
  ) {
    return { ok: false, code: "invalid_member_count" };
  }

  const members: GroupSequenceMemberPlan[] = [];
  for (let memberIndex = 0; memberIndex < value.members.length; memberIndex += 1) {
    const raw = value.members[memberIndex];
    if (!record(raw) || raw.memberIndex !== memberIndex) {
      return { ok: false, code: "invalid_member_order" };
    }
    const parsed = parseMemberPlan(raw, memberIndex);
    if (!parsed) return { ok: false, code: "invalid_member_segments" };
    members.push(parsed);
  }

  if (new Set(members.map((member) => member.memberRequestId)).size !== members.length) {
    return { ok: false, code: "duplicate_member_request" };
  }
  const serviceLineCount = members.reduce(
    (sum, member) => sum + member.segments.length,
    0,
  );
  if (serviceLineCount > GROUP_SEQUENCE_MAX_TOTAL_LINES) {
    return { ok: false, code: "too_many_service_lines" };
  }

  const staffClaims: OccupiedClaim[] = [];
  const resourceClaims: OccupiedClaim[] = [];
  const starts: number[] = [];
  const finishes: number[] = [];
  let totalCustomerWaitMinutes = 0;
  for (const member of members) {
    const first = member.segments[0];
    const last = member.segments[member.segments.length - 1];
    starts.push(Date.parse(first.serviceStartUtc));
    finishes.push(Date.parse(last.serviceEndUtc));
    for (let lineIndex = 0; lineIndex < member.segments.length; lineIndex += 1) {
      const segment = member.segments[lineIndex];
      const startMs = Date.parse(segment.occupiedStartUtc);
      const endMs = Date.parse(segment.occupiedEndUtc);
      staffClaims.push({
        memberIndex: member.memberIndex,
        claimId: segment.resolvedStaffId,
        startMs,
        endMs,
      });
      if (segment.resolvedResourceId) {
        resourceClaims.push({
          memberIndex: member.memberIndex,
          claimId: segment.resolvedResourceId,
          startMs,
          endMs,
        });
      }
      if (lineIndex > 0) {
        totalCustomerWaitMinutes += Math.max(
          0,
          Math.round(
            (Date.parse(segment.serviceStartUtc) -
              Date.parse(member.segments[lineIndex - 1].serviceEndUtc)) /
              60_000,
          ),
        );
      }
    }
  }

  const staffConflict = claimsOverlap(staffClaims);
  if (staffConflict) {
    return {
      ok: false,
      code: "staff_overlap",
      memberIndexes: [staffConflict[0].memberIndex, staffConflict[1].memberIndex],
      resourceOrStaffId: staffConflict[0].claimId,
    };
  }
  const resourceConflict = claimsOverlap(resourceClaims);
  if (resourceConflict) {
    return {
      ok: false,
      code: "resource_overlap",
      memberIndexes: [resourceConflict[0].memberIndex, resourceConflict[1].memberIndex],
      resourceOrStaffId: resourceConflict[0].claimId,
    };
  }

  if (value.seatTogether) {
    const firstResourceIds = members.map(
      (member) => member.segments[0].resolvedResourceId,
    );
    const startSpreadMinutes = Math.round(
      (Math.max(...starts) - Math.min(...starts)) / 60_000,
    );
    const maxStartSpread = options.maxSeatTogetherStartSpreadMinutes ?? 30;
    if (
      !Number.isSafeInteger(maxStartSpread) ||
      maxStartSpread < 0 ||
      startSpreadMinutes > maxStartSpread
    ) {
      return { ok: false, code: "arrival_spread_exceeded" };
    }
    if (
      firstResourceIds.some((resourceId) => resourceId == null) ||
      new Set(firstResourceIds).size !== firstResourceIds.length ||
      !adjacentResourceSet(
        options.adjacentResourceGroups ?? [],
        firstResourceIds as string[],
      )
    ) {
      return { ok: false, code: "seat_together_unproven" };
    }
  }

  const groupStartMs = Math.min(...starts);
  const groupEndMs = Math.max(...finishes);
  return {
    ok: true,
    plan: {
      contractVersion: 1,
      salonId,
      groupRequestId,
      requestedAnchorUtc,
      seatTogether: value.seatTogether,
      members,
    },
    summary: {
      groupStartUtc: new Date(groupStartMs).toISOString(),
      groupEndUtc: new Date(groupEndMs).toISOString(),
      startSpreadMinutes: Math.round((Math.max(...starts) - groupStartMs) / 60_000),
      finishSpreadMinutes: Math.round((groupEndMs - Math.min(...finishes)) / 60_000),
      totalCustomerWaitMinutes,
      memberCount: members.length,
      serviceLineCount,
    },
  };
}
