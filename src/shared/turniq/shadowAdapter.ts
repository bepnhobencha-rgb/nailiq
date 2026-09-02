import type { ReceptionistCenterData } from "@/shared/dashboard/loadReceptionistCenterData";
import type {
  TurnIqAssignmentRequest,
  TurnIqCandidateInput,
  TurnIqDecisionInput,
  TurnIqPolicyVersion,
  TurnIqResourceAvailability,
} from "@/shared/turniq/contracts";
import { canonicalTurnIqJson, sha256TurnIqHex } from "@/shared/turniq/fingerprint";
import { TurnIqContractError } from "@/shared/turniq/singleCustomerEngine";

export type TurnIqShadowShiftState = {
  staffId: string;
  checkInSessionId: string;
  checkedInAt: string;
  queuePosition: number;
  state: "active" | "approved_break" | "temporary_hold" | "checked_out";
  refusalPenaltyActive: boolean;
  manualSafetyHold: boolean;
  serviceCreditSinceCheckInCents: number;
  fairnessBaselineCents: number;
};

export type TurnIqReceptionistShadowSource = {
  data: ReceptionistCenterData;
  policy: TurnIqPolicyVersion;
  request: TurnIqAssignmentRequest;
  shiftStates: readonly TurnIqShadowShiftState[];
  resources: readonly TurnIqResourceAvailability[];
};

function compareStableText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function nextAppointmentStart(
  bookings: ReceptionistCenterData["bookingsForDay"],
  staffId: string,
  requestedStartAt: string,
  excludedBookingId: string | null,
): string | null {
  const requestedMs = Date.parse(requestedStartAt);
  const future = bookings
    .filter(
      (booking) =>
        booking.staff_id === staffId &&
        booking.id !== excludedBookingId &&
        booking.status !== "completed" &&
        Date.parse(booking.start_time_utc) >= requestedMs,
    )
    .sort((left, right) => {
      const timeDifference =
        Date.parse(left.start_time_utc) - Date.parse(right.start_time_utc);
      return timeDifference !== 0
        ? timeDifference
        : compareStableText(left.id, right.id);
    });
  return future[0]?.start_time_utc ?? null;
}

function snapshotFingerprintMaterial(
  source: TurnIqReceptionistShadowSource,
  candidates: readonly TurnIqCandidateInput[],
): unknown {
  return {
    source: "receptionist_center",
    salonId: source.data.salon.id,
    selectedDate: source.data.selectedDate,
    observedAtIso: source.data.observedAtIso,
    requestId: source.request.requestId,
    candidates: [...candidates]
      .sort((left, right) => compareStableText(left.stableStaffId, right.stableStaffId))
      .map((candidate) => ({
        ...candidate,
        displayName: undefined,
        capableServiceIds: [...candidate.capableServiceIds].sort(compareStableText),
      })),
    resources: [...source.resources].sort((left, right) =>
      compareStableText(left.resourceId, right.resourceId),
    ),
  };
}

/**
 * Read-only adapter from the current Receptionist Center contract into the
 * deterministic TurnIQ engine. It never mutates or writes Receptionist data.
 * Missing capability rows fail closed; missing shift state means not checked in.
 */
export async function buildTurnIqShadowDecisionInput(
  source: TurnIqReceptionistShadowSource,
): Promise<TurnIqDecisionInput> {
  if (
    source.data.salon.id !== source.policy.salonId ||
    source.data.salon.id !== source.request.salonId
  ) {
    throw new TurnIqContractError("turniq_shadow_cross_salon_source");
  }
  if (source.policy.effectiveBusinessDate > source.data.selectedDate) {
    throw new TurnIqContractError("turniq_shadow_policy_not_effective");
  }

  const shiftByStaff = new Map(
    source.shiftStates.map((shift) => [shift.staffId, shift] as const),
  );
  if (shiftByStaff.size !== source.shiftStates.length) {
    throw new TurnIqContractError("turniq_shadow_duplicate_shift_staff");
  }

  const capabilities = source.data.capabilityRows === null
    ? null
    : source.data.capabilityRows.reduce((map, row) => {
        const serviceIds = map.get(row.staff_id) ?? new Set<string>();
        serviceIds.add(row.service_id);
        map.set(row.staff_id, serviceIds);
        return map;
      }, new Map<string, Set<string>>());

  const sortedStaff = [...source.data.staff].sort((left, right) =>
    compareStableText(left.id, right.id),
  );
  const largestQueuePosition = source.shiftStates.reduce(
    (largest, shift) => Math.max(largest, shift.queuePosition),
    0,
  );

  const candidates: TurnIqCandidateInput[] = sortedStaff.map((staff, index) => {
    const shift = shiftByStaff.get(staff.id);
    const checkedIn = shift !== undefined && shift.state !== "checked_out";
    return {
      staffId: staff.id,
      displayName: staff.name,
      stableStaffId: staff.id,
      checkInSessionId: shift?.checkInSessionId ?? `missing:${staff.id}`,
      checkedInAt: shift?.checkedInAt ?? source.data.observedAtIso,
      queuePosition: shift?.queuePosition ?? largestQueuePosition + index + 1,
      checkedIn,
      active: staff.status !== "offline" && checkedIn,
      busy: staff.status === "busy" || staff.status === "overbooked",
      approvedBreak: shift?.state === "approved_break",
      temporaryHold: shift?.state === "temporary_hold",
      refusalPenaltyActive: shift?.refusalPenaltyActive ?? false,
      manualSafetyHold: shift?.manualSafetyHold ?? false,
      capabilityDataComplete: capabilities !== null,
      capableServiceIds: capabilities === null
        ? []
        : [...(capabilities.get(staff.id) ?? [])].sort(compareStableText),
      nextAppointmentStartsAt: nextAppointmentStart(
        source.data.bookingsForDay,
        staff.id,
        source.request.requestedStartAt,
        source.request.bookingId,
      ),
      serviceCreditSinceCheckInCents:
        shift?.serviceCreditSinceCheckInCents ?? 0,
      fairnessBaselineCents: shift?.fairnessBaselineCents ?? 0,
    };
  });

  const snapshotVersion = await sha256TurnIqHex(
    canonicalTurnIqJson(snapshotFingerprintMaterial(source, candidates)),
  );

  return {
    policy: structuredClone(source.policy),
    request: structuredClone(source.request),
    snapshot: {
      snapshotVersion,
      capturedAt: source.data.observedAtIso,
      businessDate: source.data.selectedDate,
      candidates,
      resources: structuredClone(source.resources),
    },
  };
}
