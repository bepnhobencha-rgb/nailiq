import type {
  TurnIqCandidateInput,
  TurnIqDecisionInput,
  TurnIqPolicyVersion,
  TurnIqResourceAvailability,
  TurnIqServiceLine,
} from "@/shared/turniq/contracts";
import { canonicalTurnIqJson, sha256TurnIqHex } from "@/shared/turniq/fingerprint";
import { TurnIqContractError } from "@/shared/turniq/singleCustomerEngine";

export type TurnIqTrustedBooking = {
  id: string;
  salonId: string;
  serviceId: string;
  addonServiceId: string | null;
  staffId: string | null;
  staffRequestedByClient: boolean;
  createdAt: string;
  startAt: string;
  endAt: string;
  status: "pending" | "confirmed" | "waiting";
  scheduleModel: string;
  partySize: number;
  groupId: string | null;
  resourceId: string | null;
  hasBookingAddonRows: boolean;
};

export type TurnIqTrustedService = {
  id: string;
  name: string;
  priceCents: number;
  durationMinutes: number;
  bufferMinutes: number;
  isAddon: boolean;
  resourceRequirementMode: "salon_default" | "none" | "specific";
  requiredResourceKinds: readonly string[];
};

export type TurnIqTrustedStaff = {
  id: string;
  name: string;
  active: boolean;
};

export type TurnIqTrustedShift = {
  id: string;
  policyVersionId: string;
  staffId: string;
  businessDate: string;
  checkedInAt: string;
  state: "active" | "approved_break" | "temporary_hold" | "checked_out";
  queuePosition: number;
  fairnessBaselineCents: number;
  serviceCreditSinceCheckInCents: number;
  stateVersion: number;
};

export type TurnIqTrustedCapability = {
  staffId: string;
  serviceId: string;
};

export type TurnIqTrustedOccupiedBooking = {
  id: string;
  staffId: string | null;
  resourceId: string | null;
  startAt: string;
  endAt: string;
  status: string;
};

export type TurnIqTrustedResource = {
  id: string;
  kind: string;
  active: boolean;
};

export type TurnIqTrustedSnapshotSource = {
  salonId: string;
  resourcesEnabled: boolean;
  capturedAt: string;
  businessDate: string;
  policy: TurnIqPolicyVersion;
  booking: TurnIqTrustedBooking;
  services: readonly TurnIqTrustedService[];
  staff: readonly TurnIqTrustedStaff[];
  shifts: readonly TurnIqTrustedShift[];
  capabilities: readonly TurnIqTrustedCapability[] | null;
  occupiedBookings: readonly TurnIqTrustedOccupiedBooking[];
  resources: readonly TurnIqTrustedResource[];
};

export type TurnIqTrustedDecisionInput = {
  decisionInput: TurnIqDecisionInput;
  resourceId: string | null;
  confirmationSnapshot: TurnIqTrustedConfirmationSnapshot;
};

export type TurnIqTrustedConfirmationSnapshot = {
  version: 1;
  businessDate: string;
  resourcesEnabled: boolean;
  booking: {
    bookingId: string;
    serviceId: string;
    addonServiceId: string | null;
    startAtMs: number;
    endAtMs: number;
    resourceId: string | null;
    safeEndAtMs: number;
  };
  shifts: readonly {
    shiftSessionId: string;
    staffId: string;
    stateVersion: number;
  }[];
  catalog: readonly {
    staffId: string;
    active: boolean;
    capableServiceIds: readonly string[];
  }[];
  services: readonly {
    serviceId: string;
    priceCents: number;
    durationMinutes: number;
    bufferMinutes: number;
    resourceRequirementMode: TurnIqTrustedService["resourceRequirementMode"];
    requiredResourceKinds: readonly string[];
  }[];
  resources: readonly {
    resourceId: string;
    kind: string;
    active: boolean;
  }[];
  capacity: readonly {
    id: string;
    staffId: string | null;
    resourceId: string | null;
    startAtMs: number;
    endAtMs: number;
    status: string;
  }[];
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
  row: TurnIqTrustedOccupiedBooking,
  startMs: number,
  endMs: number,
): boolean {
  return millis(row.startAt, "turniq_invalid_occupied_start") < endMs &&
    millis(row.endAt, "turniq_invalid_occupied_end") > startMs;
}

function serviceResourceKinds(
  source: TurnIqTrustedSnapshotSource,
  service: TurnIqTrustedService,
): readonly string[] {
  if (!source.resourcesEnabled || service.resourceRequirementMode === "none") {
    return [];
  }
  if (service.resourceRequirementMode === "specific") {
    if (service.requiredResourceKinds.length !== 1) {
      // The current service schema models this list as alternatives while the
      // V1 engine contract models required types conjunctively. Fail closed
      // until M4 introduces an explicit alternatives contract.
      throw new TurnIqContractError("turniq_resource_alternatives_unsupported");
    }
    return [...service.requiredResourceKinds];
  }
  if (!source.booking.resourceId) {
    throw new TurnIqContractError("turniq_default_resource_unresolved");
  }
  const assigned = source.resources.find(
    (resource) => resource.id === source.booking.resourceId && resource.active,
  );
  if (!assigned) {
    throw new TurnIqContractError("turniq_assigned_resource_unavailable");
  }
  return [assigned.kind];
}

function serviceLines(source: TurnIqTrustedSnapshotSource): TurnIqServiceLine[] {
  const main = source.services.find(
    (service) => service.id === source.booking.serviceId && !service.isAddon,
  );
  if (!main) throw new TurnIqContractError("turniq_main_service_unavailable");
  if (source.booking.hasBookingAddonRows) {
    // M3A's atomic RPC currently credits the legacy addon_service_id only.
    // Refuse newer booking_addons rows rather than produce a fairness receipt
    // whose opportunity credit disagrees with the ledger.
    throw new TurnIqContractError("turniq_booking_addon_ledger_not_supported");
  }

  const addon = source.booking.addonServiceId
    ? source.services.find(
        (service) =>
          service.id === source.booking.addonServiceId && service.isAddon,
      )
    : null;
  if (source.booking.addonServiceId && !addon) {
    throw new TurnIqContractError("turniq_addon_service_unavailable");
  }

  const requiredKinds = new Set(serviceResourceKinds(source, main));
  if (addon) {
    for (const kind of serviceResourceKinds(source, addon)) {
      requiredKinds.add(kind);
    }
  }
  if (requiredKinds.size > 1) {
    throw new TurnIqContractError("turniq_multi_resource_service_unsupported");
  }

  const lines: TurnIqServiceLine[] = [
    {
      lineId: `booking:${source.booking.id}:main`,
      serviceId: main.id,
      serviceName: main.name,
      catalogPriceCents: main.priceCents,
      permittedAddonCents: 0,
      durationMinutes: main.durationMinutes,
      bufferMinutes: main.bufferMinutes,
      requiredResourceTypeIds: [...requiredKinds],
    },
  ];
  if (addon) {
    // Keep the add-on as its own capability line so a technician must be
    // qualified for both services. Conservative sequential timing is safe for
    // M3C; explicit concurrent add-on timing belongs in the M4 constraint model.
    lines.push({
      lineId: `booking:${source.booking.id}:addon`,
      serviceId: addon.id,
      serviceName: addon.name,
      catalogPriceCents: 0,
      permittedAddonCents: addon.priceCents,
      durationMinutes: Math.max(1, addon.durationMinutes),
      bufferMinutes: addon.bufferMinutes,
      requiredResourceTypeIds: [...requiredKinds],
    });
  }
  return lines;
}

function resourceAvailability(
  source: TurnIqTrustedSnapshotSource,
  startMs: number,
  endMs: number,
): TurnIqResourceAvailability[] {
  return source.resources
    .filter((resource) => resource.active)
    .sort((left, right) => compareText(left.id, right.id))
    .map((resource) => ({
      resourceId: resource.id,
      resourceTypeId: resource.kind,
      available: !source.occupiedBookings.some(
        (booking) =>
          booking.id !== source.booking.id &&
          booking.resourceId === resource.id &&
          overlaps(booking, startMs, endMs),
      ),
    }));
}

function selectedResourceId(
  source: TurnIqTrustedSnapshotSource,
  lines: readonly TurnIqServiceLine[],
  resources: readonly TurnIqResourceAvailability[],
): string | null {
  const requiredKind = lines[0]?.requiredResourceTypeIds[0] ?? null;
  if (!requiredKind) return null;
  if (source.booking.resourceId) {
    const assigned = resources.find(
      (resource) => resource.resourceId === source.booking.resourceId,
    );
    if (!assigned || !assigned.available || assigned.resourceTypeId !== requiredKind) {
      throw new TurnIqContractError("turniq_assigned_resource_conflict");
    }
    return assigned.resourceId;
  }
  return resources.find(
    (resource) => resource.resourceTypeId === requiredKind && resource.available,
  )?.resourceId ?? null;
}

/**
 * Converts a server-authorized, salon-scoped snapshot into the pure TurnIQ
 * engine contract. No customer name, phone, email, note, payment or tip enters
 * this boundary or its deterministic fingerprint.
 */
export async function buildTrustedTurnIqDecisionInput(
  source: TurnIqTrustedSnapshotSource,
): Promise<TurnIqTrustedDecisionInput> {
  const booking = source.booking;
  if (
    source.salonId !== source.policy.salonId ||
    source.salonId !== booking.salonId
  ) {
    throw new TurnIqContractError("turniq_trusted_cross_salon_source");
  }
  if (
    booking.scheduleModel !== "single" ||
    booking.partySize !== 1 ||
    booking.groupId !== null
  ) {
    throw new TurnIqContractError("turniq_trusted_single_booking_required");
  }
  if (!(["pending", "confirmed", "waiting"] as const).includes(booking.status)) {
    throw new TurnIqContractError("turniq_trusted_booking_not_recommendable");
  }
  if (source.policy.effectiveBusinessDate > source.businessDate) {
    throw new TurnIqContractError("turniq_trusted_policy_not_effective");
  }

  const startMs = millis(booking.startAt, "turniq_invalid_booking_start");
  const endMs = millis(booking.endAt, "turniq_invalid_booking_end");
  if (endMs <= startMs) throw new TurnIqContractError("turniq_invalid_booking_range");

  const lines = serviceLines(source);
  const catalogOccupiedMinutes = lines.reduce(
    (sum, line) => sum + line.durationMinutes + line.bufferMinutes,
    0,
  );
  const safeEndMs = Math.max(endMs, startMs + catalogOccupiedMinutes * 60_000);
  const resources = resourceAvailability(source, startMs, safeEndMs);
  const resourceId = selectedResourceId(source, lines, resources);
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
  const activeBookingStatuses = new Set(["pending", "confirmed", "in_progress"]);

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
      const staffBookings = source.occupiedBookings.filter(
        (row) =>
          row.id !== booking.id &&
          row.staffId === staff.id &&
          activeBookingStatuses.has(row.status),
      );
      const nextAppointmentStartsAt = staffBookings
        .filter((row) => millis(row.startAt, "turniq_invalid_occupied_start") >= startMs)
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
        busy: staffBookings.some((row) => overlaps(row, startMs, safeEndMs)),
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

  const fingerprintMaterial = {
    source: "trusted_server_snapshot_v1",
    salonId: source.salonId,
    businessDate: source.businessDate,
    capturedAt: source.capturedAt,
    policyId: source.policy.policyId,
    policyVersion: source.policy.version,
    booking: {
      id: booking.id,
      serviceId: booking.serviceId,
      addonServiceId: booking.addonServiceId,
      startAt: booking.startAt,
      endAt: booking.endAt,
      resourceId: booking.resourceId,
      staffRequestedByClient: booking.staffRequestedByClient,
      staffId: booking.staffId,
    },
    candidates,
    resources,
  };
  const snapshotVersion = await sha256TurnIqHex(
    canonicalTurnIqJson(fingerprintMaterial),
  );
  const requestedServiceIds = lines.map((line) => line.serviceId).sort(compareText);
  const capabilityRows = source.capabilities ?? [];
  const confirmationSnapshot: TurnIqTrustedConfirmationSnapshot = {
    version: 1,
    businessDate: source.businessDate,
    resourcesEnabled: source.resourcesEnabled,
    booking: {
      bookingId: booking.id,
      serviceId: booking.serviceId,
      addonServiceId: booking.addonServiceId,
      startAtMs: startMs,
      endAtMs: endMs,
      resourceId,
      safeEndAtMs: safeEndMs,
    },
    shifts: [...source.shifts]
      .sort((left, right) => compareText(left.id, right.id))
      .map((shift) => ({
        shiftSessionId: shift.id,
        staffId: shift.staffId,
        stateVersion: shift.stateVersion,
      })),
    catalog: [...source.staff]
      .sort((left, right) => compareText(left.id, right.id))
      .map((staff) => ({
        staffId: staff.id,
        active: staff.active,
        capableServiceIds: requestedServiceIds.filter((serviceId) =>
          capabilityRows.some(
            (row) => row.staffId === staff.id && row.serviceId === serviceId,
          ),
        ),
      })),
    services: [...source.services]
      .sort((left, right) => compareText(left.id, right.id))
      .map((service) => ({
        serviceId: service.id,
        priceCents: service.priceCents,
        durationMinutes: service.durationMinutes,
        bufferMinutes: service.bufferMinutes,
        resourceRequirementMode: service.resourceRequirementMode,
        requiredResourceKinds: [...service.requiredResourceKinds].sort(compareText),
      })),
    resources: [...source.resources]
      .sort((left, right) => compareText(left.id, right.id))
      .map((resource) => ({
        resourceId: resource.id,
        kind: resource.kind,
        active: resource.active,
      })),
    capacity: [...source.occupiedBookings]
      .sort((left, right) => compareText(left.id, right.id))
      .map((row) => ({
        id: row.id,
        staffId: row.staffId,
        resourceId: row.resourceId,
        startAtMs: millis(row.startAt, "turniq_invalid_occupied_start"),
        endAtMs: millis(row.endAt, "turniq_invalid_occupied_end"),
        status: row.status,
      })),
  };

  return {
    resourceId,
    confirmationSnapshot,
    decisionInput: {
      policy: structuredClone(source.policy),
      request: {
        requestId: `booking:${booking.id}`,
        salonId: source.salonId,
        bookingId: booking.id,
        requestedStartAt: booking.startAt,
        partySize: 1,
        serviceLines: lines,
        requestedTechnician:
          booking.staffRequestedByClient && booking.staffId
            ? {
                staffId: booking.staffId,
                source: "legacy_unknown",
                actorId: `legacy-booking:${booking.id}`,
                recordedAt: booking.createdAt,
              }
            : null,
      },
      snapshot: {
        snapshotVersion,
        capturedAt: source.capturedAt,
        businessDate: source.businessDate,
        candidates,
        resources,
      },
    },
  };
}
