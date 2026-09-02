import type {
  TurnIqCandidateInput,
  TurnIqGroupDecisionInput,
  TurnIqGroupResourceAvailability,
  TurnIqPolicyVersion,
  TurnIqServiceLine,
} from "@/shared/turniq/contracts";
import { canonicalTurnIqJson, sha256TurnIqHex } from "@/shared/turniq/fingerprint";
import { TurnIqContractError } from "@/shared/turniq/singleCustomerEngine";
import type {
  TurnIqTrustedCapability,
  TurnIqTrustedOccupiedBooking,
  TurnIqTrustedResource,
  TurnIqTrustedService,
  TurnIqTrustedShift,
  TurnIqTrustedStaff,
} from "@/shared/turniq/trustedSnapshot";

export type TurnIqTrustedGroupBooking = {
  id: string;
  salonId: string;
  groupId: string;
  serviceId: string;
  addonServiceId: string | null;
  staffId: string | null;
  startAt: string;
  endAt: string;
  status: "pending" | "confirmed" | "waiting";
  scheduleModel: string;
  resourceId: string | null;
  hasBookingAddonRows: boolean;
  hasServiceSegments: boolean;
};

export type TurnIqTrustedGroupSnapshotSource = {
  salonId: string;
  resourcesEnabled: boolean;
  capturedAt: string;
  businessDate: string;
  policy: TurnIqPolicyVersion;
  bookingGroupId: string;
  bookings: readonly TurnIqTrustedGroupBooking[];
  services: readonly TurnIqTrustedService[];
  staff: readonly TurnIqTrustedStaff[];
  shifts: readonly TurnIqTrustedShift[];
  capabilities: readonly TurnIqTrustedCapability[] | null;
  occupiedBookings: readonly TurnIqTrustedOccupiedBooking[];
  resources: readonly TurnIqTrustedResource[];
};

export type TurnIqTrustedGroupDecisionInput = {
  decisionInput: TurnIqGroupDecisionInput;
  bookingIds: readonly string[];
};

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function millis(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TurnIqContractError(code);
  return parsed;
}

function serviceById(
  source: TurnIqTrustedGroupSnapshotSource,
  serviceId: string,
  addon: boolean,
): TurnIqTrustedService {
  const service = source.services.find(
    (entry) => entry.id === serviceId && entry.isAddon === addon,
  );
  if (!service) {
    throw new TurnIqContractError(
      addon
        ? "turniq_group_addon_service_unavailable"
        : "turniq_group_main_service_unavailable",
    );
  }
  return service;
}

function resourceKinds(
  source: TurnIqTrustedGroupSnapshotSource,
  booking: TurnIqTrustedGroupBooking,
  service: TurnIqTrustedService,
): readonly string[] {
  if (!source.resourcesEnabled || service.resourceRequirementMode === "none") {
    return [];
  }
  if (service.resourceRequirementMode === "specific") {
    if (service.requiredResourceKinds.length !== 1) {
      throw new TurnIqContractError(
        "turniq_group_resource_alternatives_unsupported",
      );
    }
    return [...service.requiredResourceKinds];
  }
  if (!booking.resourceId) {
    throw new TurnIqContractError(
      "turniq_group_default_resource_unresolved",
    );
  }
  const assigned = source.resources.find(
    (resource) => resource.id === booking.resourceId && resource.active,
  );
  if (!assigned) {
    throw new TurnIqContractError(
      "turniq_group_assigned_resource_unavailable",
    );
  }
  return [assigned.kind];
}

function serviceLines(
  source: TurnIqTrustedGroupSnapshotSource,
  booking: TurnIqTrustedGroupBooking,
): TurnIqServiceLine[] {
  if (booking.hasBookingAddonRows) {
    throw new TurnIqContractError(
      "turniq_group_booking_addon_ledger_not_supported",
    );
  }
  if (booking.hasServiceSegments) {
    throw new TurnIqContractError(
      "turniq_group_service_segments_not_supported",
    );
  }
  const main = serviceById(source, booking.serviceId, false);
  const addon = booking.addonServiceId
    ? serviceById(source, booking.addonServiceId, true)
    : null;
  const requiredKinds = new Set(resourceKinds(source, booking, main));
  if (addon) {
    for (const kind of resourceKinds(source, booking, addon)) {
      requiredKinds.add(kind);
    }
  }
  // The M4B ledger has one authoritative resource slot per booking. Do not
  // collapse a genuine multi-resource service into a misleading single slot.
  if (requiredKinds.size > 1) {
    throw new TurnIqContractError(
      "turniq_group_multi_resource_service_unsupported",
    );
  }
  const kinds = [...requiredKinds].sort(compareText);
  const lines: TurnIqServiceLine[] = [
    {
      lineId: `booking:${booking.id}:main`,
      serviceId: main.id,
      serviceName: main.name,
      catalogPriceCents: main.priceCents,
      permittedAddonCents: 0,
      durationMinutes: main.durationMinutes,
      bufferMinutes: main.bufferMinutes,
      requiredResourceTypeIds: kinds,
    },
  ];
  if (addon) {
    // Sequential is intentionally conservative until add-on timing becomes an
    // explicit trusted group contract. The database independently rechecks it.
    lines.push({
      lineId: `booking:${booking.id}:addon`,
      serviceId: addon.id,
      serviceName: addon.name,
      catalogPriceCents: 0,
      permittedAddonCents: addon.priceCents,
      durationMinutes: Math.max(1, addon.durationMinutes),
      bufferMinutes: addon.bufferMinutes,
      requiredResourceTypeIds: kinds,
    });
  }
  return lines;
}

function availableAt(
  requestedStartMs: number,
  occupied: readonly TurnIqTrustedOccupiedBooking[],
): number {
  let readyAt = requestedStartMs;
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of occupied) {
      const start = millis(row.startAt, "turniq_invalid_occupied_start");
      const end = millis(row.endAt, "turniq_invalid_occupied_end");
      if (start <= readyAt && end > readyAt) {
        readyAt = end;
        changed = true;
      }
    }
  }
  return readyAt;
}

/**
 * Builds the pure M4A input from server-owned rows only. Customer PII, notes,
 * payment, tax, tip and browser-proposed technician/resource fields are absent
 * from both the decision and its snapshot fingerprint.
 */
export async function buildTrustedTurnIqGroupDecisionInput(
  source: TurnIqTrustedGroupSnapshotSource,
): Promise<TurnIqTrustedGroupDecisionInput> {
  if (
    source.salonId !== source.policy.salonId ||
    source.bookings.length < 2 ||
    source.bookings.length > 12
  ) {
    throw new TurnIqContractError("turniq_trusted_group_membership_invalid");
  }
  if (source.policy.effectiveBusinessDate > source.businessDate) {
    throw new TurnIqContractError("turniq_trusted_policy_not_effective");
  }
  const bookings = [...source.bookings].sort((left, right) =>
    compareText(left.id, right.id),
  );
  const bookingIds = new Set<string>();
  const requestedStartAt = bookings[0]?.startAt;
  if (!requestedStartAt) {
    throw new TurnIqContractError("turniq_trusted_group_membership_invalid");
  }
  const requestedStartMs = millis(
    requestedStartAt,
    "turniq_invalid_group_requested_start",
  );
  for (const booking of bookings) {
    if (
      bookingIds.has(booking.id) ||
      booking.salonId !== source.salonId ||
      booking.groupId !== source.bookingGroupId ||
      booking.startAt !== requestedStartAt ||
      booking.scheduleModel !== "single" ||
      booking.staffId !== null ||
      !(["pending", "confirmed", "waiting"] as const).includes(booking.status)
    ) {
      throw new TurnIqContractError("turniq_trusted_group_member_invalid");
    }
    const end = millis(booking.endAt, "turniq_invalid_group_booking_end");
    if (end <= requestedStartMs) {
      throw new TurnIqContractError("turniq_invalid_group_booking_range");
    }
    bookingIds.add(booking.id);
  }

  const tasks = bookings.map((booking) => ({
    taskId: booking.id,
    serviceLines: serviceLines(source, booking),
    // Current bookings retain only a legacy boolean, not authoritative source,
    // actor and timestamp. Never manufacture customer-request provenance.
    requestedTechnician: null,
  }));
  const groupBookingIds = new Set(bookings.map((booking) => booking.id));
  const activeStatuses = new Set(["pending", "confirmed", "in_progress"]);
  const occupied = source.occupiedBookings.filter(
    (row) => !groupBookingIds.has(row.id) && activeStatuses.has(row.status),
  );
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

  const staffAvailability = [...source.staff]
    .sort((left, right) => compareText(left.id, right.id))
    .map((staff) => {
      const conflicts = occupied.filter((row) => row.staffId === staff.id);
      return {
        staffId: staff.id,
        availableAt: new Date(availableAt(requestedStartMs, conflicts)).toISOString(),
      };
    });
  const candidates: TurnIqCandidateInput[] = [...source.staff]
    .sort((left, right) => compareText(left.id, right.id))
    .map((staff, index) => {
      const shift = shifts.get(staff.id);
      const checkedIn = Boolean(
        shift &&
          shift.policyVersionId === source.policy.policyId &&
          shift.businessDate === source.businessDate &&
          shift.state !== "checked_out",
      );
      const available = staffAvailability.find(
        (entry) => entry.staffId === staff.id,
      );
      const nextAppointmentStartsAt = occupied
        .filter(
          (row) =>
            row.staffId === staff.id &&
            millis(row.startAt, "turniq_invalid_occupied_start") >=
              requestedStartMs,
        )
        .sort((left, right) => {
          const difference = Date.parse(left.startAt) - Date.parse(right.startAt);
          return difference || compareText(left.id, right.id);
        })[0]?.startAt ?? null;
      return {
        staffId: staff.id,
        displayName: staff.name,
        stableStaffId: staff.id,
        checkInSessionId: shift?.id ?? `missing:${staff.id}`,
        checkedInAt: shift?.checkedInAt ?? source.capturedAt,
        queuePosition: shift?.queuePosition ?? source.shifts.length + index + 1,
        checkedIn,
        active: staff.active && checkedIn,
        busy: Boolean(
          available && Date.parse(available.availableAt) > requestedStartMs,
        ),
        approvedBreak: shift?.state === "approved_break",
        temporaryHold: shift?.state === "temporary_hold",
        refusalPenaltyActive: false,
        manualSafetyHold: false,
        capabilityDataComplete: capabilityMap !== null,
        capableServiceIds: capabilityMap
          ? [...(capabilityMap.get(staff.id) ?? [])].sort(compareText)
          : [],
        nextAppointmentStartsAt,
        serviceCreditSinceCheckInCents:
          shift?.serviceCreditSinceCheckInCents ?? 0,
        fairnessBaselineCents: shift?.fairnessBaselineCents ?? 0,
      };
    });
  const resources: TurnIqGroupResourceAvailability[] = source.resources
    .filter((resource) => resource.active)
    .sort((left, right) => compareText(left.id, right.id))
    .map((resource) => ({
      resourceId: resource.id,
      resourceTypeId: resource.kind,
      available: true,
      availableAt: new Date(
        availableAt(
          requestedStartMs,
          occupied.filter((row) => row.resourceId === resource.id),
        ),
      ).toISOString(),
    }));

  const fingerprintMaterial = {
    source: "trusted_server_group_snapshot_v1",
    salonId: source.salonId,
    bookingGroupId: source.bookingGroupId,
    businessDate: source.businessDate,
    capturedAt: source.capturedAt,
    policyId: source.policy.policyId,
    policyVersion: source.policy.version,
    bookings: bookings.map((booking) => ({
      id: booking.id,
      serviceId: booking.serviceId,
      addonServiceId: booking.addonServiceId,
      startAt: booking.startAt,
      endAt: booking.endAt,
      resourceId: booking.resourceId,
    })),
    candidates,
    staffAvailability,
    resources,
  };
  const snapshotVersion = await sha256TurnIqHex(
    canonicalTurnIqJson(fingerprintMaterial),
  );

  return {
    bookingIds: bookings.map((booking) => booking.id),
    decisionInput: {
      policy: structuredClone(source.policy),
      request: {
        requestId: source.bookingGroupId,
        salonId: source.salonId,
        bookingGroupId: source.bookingGroupId,
        requestedStartAt,
        tasks,
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
  };
}
