import "server-only";

import { salonDayRangeUtc, salonYmdOfUtc } from "@/shared/lib/salonTime";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import type { TurnIqPolicyVersion } from "@/shared/turniq/contracts";
import {
  captureTurnIqShadowTruth,
  resolveTurnIqShadowActualAssignment,
  turnIqShadowObservationFingerprint,
  type TurnIqShadowAssignmentAuditEvent,
} from "@/shared/turniq/shadowTruth";
import { turnIqShadowTruthRepository } from "@/shared/turniq/shadowTruthRepository";
import type { TurnIqRolloutStage } from "@/shared/turniq/rolloutStage";
import { TurnIqContractError } from "@/shared/turniq/singleCustomerEngine";
import {
  buildTrustedTurnIqDecisionInput,
  type TurnIqTrustedBooking,
  type TurnIqTrustedCapability,
  type TurnIqTrustedOccupiedBooking,
  type TurnIqTrustedResource,
  type TurnIqTrustedService,
  type TurnIqTrustedShift,
  type TurnIqTrustedStaff,
} from "@/shared/turniq/trustedSnapshot";

type Row = Record<string, unknown>;
type QueryResult = { data: unknown; error: { code?: string } | null; count?: number | null };

const MAX_SHADOW_CASES_PER_CYCLE = 8;

export type TurnIqShadowCycleResult = {
  status: "captured" | "skipped" | "failed";
  examined: number;
  decisionsInserted: number;
  comparisonsInserted: number;
  unsupported: number;
};

function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new TurnIqContractError(`turniq_shadow_missing_${key}`);
  }
  return value;
}

function nullableString(row: Row, key: string): string | null {
  return typeof row[key] === "string" && String(row[key]).trim() !== ""
    ? String(row[key])
    : null;
}

function safeInteger(row: Row, key: string, fallback = 0): number {
  return Number.isSafeInteger(row[key]) ? Number(row[key]) : fallback;
}

function policyFromRow(row: Row): TurnIqPolicyVersion {
  return {
    policyId: requiredString(row, "id"),
    salonId: requiredString(row, "salon_id"),
    version: safeInteger(row, "version"),
    name: requiredString(row, "policy_name"),
    timezone: requiredString(row, "business_timezone"),
    effectiveBusinessDate: requiredString(row, "effective_business_date"),
    fairnessBandCents: safeInteger(row, "fairness_band_cents"),
    opportunityCreditStrategy:
      "catalog_plus_permitted_addons_before_tax_and_tip",
    lateArrivalBaselineStrategy: "median_eligible_team_credit_at_check_in",
    approvedBreakStrategy: "freeze_queue_position",
    unapprovedDepartureStrategy: "move_to_queue_end",
    unjustifiedRefusalStrategy: "move_to_queue_end",
    customerRejectionStrategy: "no_penalty",
    policyChangesDefaultToNextBusinessDay: true,
  };
}

function assertQueries(results: readonly QueryResult[]): void {
  if (results.some((result) => result.error)) {
    throw new Error("turniq_shadow_source_query_failed");
  }
}

function observationKey(row: Row, policy: TurnIqPolicyVersion): unknown {
  return {
    bookingId: requiredString(row, "id"),
    assignedStaffId: nullableString(row, "staff_id"),
    serviceId: requiredString(row, "service_id"),
    addonServiceId: nullableString(row, "addon_service_id"),
    startAt: requiredString(row, "start_time_utc"),
    endAt: requiredString(row, "end_time_utc"),
    resourceId: nullableString(row, "resource_id"),
    policyId: policy.policyId,
    policyVersion: policy.version,
  };
}

/**
 * Runs after the Receptionist Center response. It observes only the current
 * salon business day and writes immutable shadow/replay evidence. It never
 * calls an assignment RPC and never changes booking, queue, staff, resource,
 * notification, or provider state.
 */
export async function captureTurnIqShadowCycle(input: {
  salonId: string;
  businessDate: string;
  capturedAt: string;
  rolloutStage: TurnIqRolloutStage;
}): Promise<TurnIqShadowCycleResult> {
  if (input.rolloutStage !== "shadow") {
    return {
      status: "skipped",
      examined: 0,
      decisionsInserted: 0,
      comparisonsInserted: 0,
      unsupported: 0,
    };
  }

  try {
    const db = createServiceRoleClient();
    const salonResult = await db
      .from("salons")
      .select("id, timezone, resources_enabled")
      .eq("id", input.salonId)
      .maybeSingle();
    if (salonResult.error || !salonResult.data) {
      throw new Error("turniq_shadow_salon_unavailable");
    }
    const salon = salonResult.data as unknown as Row;
    const timezone = requiredString(salon, "timezone");
    if (salonYmdOfUtc(input.capturedAt, timezone) !== input.businessDate) {
      return {
        status: "skipped",
        examined: 0,
        decisionsInserted: 0,
        comparisonsInserted: 0,
        unsupported: 0,
      };
    }

    const policyResult = await db
      .from("turniq_policy_versions" as never)
      .select(
        "id, salon_id, version, policy_name, business_timezone, effective_business_date, fairness_band_cents" as never,
      )
      .eq("salon_id" as never, input.salonId)
      .lte("effective_business_date" as never, input.businessDate)
      .order("effective_business_date" as never, { ascending: false })
      .order("version" as never, { ascending: false })
      .limit(1)
      .maybeSingle();
    if (policyResult.error || !policyResult.data) {
      throw new Error("turniq_shadow_policy_unavailable");
    }
    const policy = policyFromRow(policyResult.data as unknown as Row);
    if (policy.timezone !== timezone) {
      throw new Error("turniq_shadow_policy_timezone_mismatch");
    }

    const { startUtc, endUtc } = salonDayRangeUtc(input.businessDate, timezone);
    const bookingsResult = await db
      .from("bookings")
      .select(
        "id, salon_id, service_id, addon_service_id, staff_id, staff_requested_by_client, created_at, start_time_utc, end_time_utc, status, schedule_model, party_size, group_id, resource_id, deleted_at",
      )
      .eq("salon_id", input.salonId)
      .is("deleted_at", null)
      .lt("start_time_utc", endUtc)
      .gt("end_time_utc", startUtc)
      .in("status", ["pending", "confirmed", "waiting", "in_progress"])
      .order("created_at", { ascending: false })
      .limit(96);
    if (bookingsResult.error) throw new Error("turniq_shadow_bookings_unavailable");
    const bookingRows = (bookingsResult.data ?? []) as unknown as Row[];
    const candidateTargets = bookingRows
      .filter(
        (row) =>
          ["pending", "confirmed", "waiting"].includes(String(row.status)) &&
          row.schedule_model === "single" &&
          safeInteger(row, "party_size", 1) === 1 &&
          row.group_id === null,
      );
    if (candidateTargets.length === 0) {
      return {
        status: "captured",
        examined: 0,
        decisionsInserted: 0,
        comparisonsInserted: 0,
        unsupported: 0,
      };
    }

    const observations = await Promise.all(
      candidateTargets.map(async (row) => {
        const key = observationKey(row, policy);
        const fingerprint = await turnIqShadowObservationFingerprint({
          salonId: input.salonId,
          bookingId: requiredString(row, "id"),
          observationKey: key,
        });
        return { row, key, fingerprint };
      }),
    );
    const existingResult = await db
      .from("turniq_shadow_decisions" as never)
      .select("observation_fingerprint" as never)
      .eq("salon_id" as never, input.salonId)
      .in(
        "observation_fingerprint" as never,
        observations.map((entry) => entry.fingerprint) as never,
      );
    if (existingResult.error) {
      throw new Error("turniq_shadow_existing_decisions_unavailable");
    }
    const existingFingerprints = new Set(
      ((existingResult.data ?? []) as unknown as Row[]).map((row) =>
        requiredString(row, "observation_fingerprint"),
      ),
    );
    const pendingObservations = observations
      .filter((entry) => !existingFingerprints.has(entry.fingerprint))
      .slice(0, MAX_SHADOW_CASES_PER_CYCLE);
    const targets = pendingObservations.map((entry) => entry.row);
    if (targets.length === 0) {
      return {
        status: "captured",
        examined: 0,
        decisionsInserted: 0,
        comparisonsInserted: 0,
        unsupported: 0,
      };
    }

    const serviceIds = [
      ...new Set(
        targets.flatMap((row) => [
          requiredString(row, "service_id"),
          nullableString(row, "addon_service_id"),
        ]).filter((value): value is string => value !== null),
      ),
    ];
    const targetIds = targets.map((row) => requiredString(row, "id"));
    const [servicesResult, staffResult, shiftsResult, capabilitiesResult, segmentsResult, resourcesResult, addonsResult, assignmentEventsResult] =
      await Promise.all([
        db
          .from("services")
          .select(
            "id, name, price_cents, duration_minutes, buffer_minutes, is_addon, resource_requirement_mode, required_resource_kinds",
          )
          .eq("salon_id", input.salonId)
          .in("id", serviceIds)
          .is("deleted_at", null),
        db
          .from("staff")
          .select("id, name, status")
          .eq("salon_id", input.salonId)
          .is("deleted_at", null),
        db
          .from("turniq_shift_sessions" as never)
          .select(
            "id, policy_version_id, staff_id, business_date, checked_in_at, state, queue_position, fairness_baseline_cents, service_credit_since_checkin_cents, state_version" as never,
          )
          .eq("salon_id" as never, input.salonId)
          .eq("policy_version_id" as never, policy.policyId)
          .eq("business_date" as never, input.businessDate)
          .is("checked_out_at" as never, null),
        db
          .from("staff_services")
          .select("staff_id, service_id")
          .in("service_id", serviceIds),
        db
          .from("booking_service_segments" as never)
          .select(
            "id, staff_id, resource_id, occupied_start_utc, occupied_end_utc, reservation_status" as never,
          )
          .eq("salon_id" as never, input.salonId)
          .lt("occupied_start_utc" as never, endUtc)
          .gt("occupied_end_utc" as never, startUtc)
          .in("reservation_status" as never, [
            "pending",
            "confirmed",
            "in_progress",
          ]),
        db
          .from("salon_resources")
          .select("id, kind, status")
          .eq("salon_id", input.salonId)
          .is("deleted_at", null),
        db
          .from("booking_addons")
          .select("booking_id")
          .in("booking_id", targetIds),
        db
          .from("booking_events" as never)
          .select("booking_id, actor_role, event_type, payload, created_at" as never)
          .eq("salon_id" as never, input.salonId)
          .in("booking_id" as never, targetIds as never)
          .in("event_type" as never, [
            "booking_edited",
            "booking_status_changed",
            "queue_assigned",
          ] as never),
      ]);
    assertQueries([
      servicesResult,
      staffResult,
      shiftsResult,
      capabilitiesResult,
      segmentsResult,
      resourcesResult,
      addonsResult,
      assignmentEventsResult,
    ] as QueryResult[]);

    const services: TurnIqTrustedService[] = ((servicesResult.data ?? []) as unknown as Row[]).map(
      (row) => ({
        id: requiredString(row, "id"),
        name: requiredString(row, "name"),
        priceCents: safeInteger(row, "price_cents"),
        durationMinutes: safeInteger(row, "duration_minutes"),
        bufferMinutes: safeInteger(row, "buffer_minutes"),
        isAddon: row.is_addon === true,
        resourceRequirementMode: requiredString(
          row,
          "resource_requirement_mode",
        ) as TurnIqTrustedService["resourceRequirementMode"],
        requiredResourceKinds: Array.isArray(row.required_resource_kinds)
          ? row.required_resource_kinds.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
      }),
    );
    const staff: TurnIqTrustedStaff[] = ((staffResult.data ?? []) as unknown as Row[]).map(
      (row) => ({
        id: requiredString(row, "id"),
        name: requiredString(row, "name"),
        active: row.status === "active",
      }),
    );
    const shifts: TurnIqTrustedShift[] = ((shiftsResult.data ?? []) as unknown as Row[]).map(
      (row) => ({
        id: requiredString(row, "id"),
        policyVersionId: requiredString(row, "policy_version_id"),
        staffId: requiredString(row, "staff_id"),
        businessDate: requiredString(row, "business_date"),
        checkedInAt: requiredString(row, "checked_in_at"),
        state: requiredString(row, "state") as TurnIqTrustedShift["state"],
        queuePosition: safeInteger(row, "queue_position"),
        fairnessBaselineCents: safeInteger(row, "fairness_baseline_cents"),
        serviceCreditSinceCheckInCents: safeInteger(
          row,
          "service_credit_since_checkin_cents",
        ),
        stateVersion: safeInteger(row, "state_version"),
      }),
    );
    const capabilities: TurnIqTrustedCapability[] = ((capabilitiesResult.data ?? []) as unknown as Row[]).map(
      (row) => ({
        staffId: requiredString(row, "staff_id"),
        serviceId: requiredString(row, "service_id"),
      }),
    );
    const occupiedBookings: TurnIqTrustedOccupiedBooking[] = [
      ...bookingRows.map((row) => ({
        id: requiredString(row, "id"),
        staffId: nullableString(row, "staff_id"),
        resourceId: nullableString(row, "resource_id"),
        startAt: requiredString(row, "start_time_utc"),
        endAt: requiredString(row, "end_time_utc"),
        status: requiredString(row, "status"),
      })),
      ...((segmentsResult.data ?? []) as unknown as Row[]).map((row) => ({
        id: `segment:${requiredString(row, "id")}`,
        staffId: nullableString(row, "staff_id"),
        resourceId: nullableString(row, "resource_id"),
        startAt: requiredString(row, "occupied_start_utc"),
        endAt: requiredString(row, "occupied_end_utc"),
        status: requiredString(row, "reservation_status"),
      })),
    ];
    const resources: TurnIqTrustedResource[] = ((resourcesResult.data ?? []) as unknown as Row[]).map(
      (row) => ({
        id: requiredString(row, "id"),
        kind: requiredString(row, "kind"),
        active: row.status === "active",
      }),
    );
    const addonBookingIds = new Set(
      ((addonsResult.data ?? []) as unknown as Row[]).map((row) =>
        requiredString(row, "booking_id"),
      ),
    );
    const assignmentEvents: TurnIqShadowAssignmentAuditEvent[] = (
      (assignmentEventsResult.data ?? []) as unknown as Row[]
    ).flatMap((row) => {
      const payload = row.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return [];
      }
      return [{
        bookingId: requiredString(row, "booking_id"),
        actorRole: nullableString(row, "actor_role"),
        eventType: requiredString(row, "event_type"),
        payload: payload as Row,
        createdAt: requiredString(row, "created_at"),
      }];
    });

    let decisionsInserted = 0;
    let comparisonsInserted = 0;
    let unsupported = 0;
    for (const row of targets) {
      try {
        const booking: TurnIqTrustedBooking = {
          id: requiredString(row, "id"),
          salonId: requiredString(row, "salon_id"),
          serviceId: requiredString(row, "service_id"),
          addonServiceId: nullableString(row, "addon_service_id"),
          staffId: nullableString(row, "staff_id"),
          staffRequestedByClient: row.staff_requested_by_client === true,
          createdAt: requiredString(row, "created_at"),
          startAt: requiredString(row, "start_time_utc"),
          endAt: requiredString(row, "end_time_utc"),
          status: requiredString(row, "status") as TurnIqTrustedBooking["status"],
          scheduleModel: requiredString(row, "schedule_model"),
          partySize: safeInteger(row, "party_size", 1),
          groupId: nullableString(row, "group_id"),
          resourceId: nullableString(row, "resource_id"),
          hasBookingAddonRows: addonBookingIds.has(requiredString(row, "id")),
        };
        const trusted = await buildTrustedTurnIqDecisionInput({
          salonId: input.salonId,
          resourcesEnabled: salon.resources_enabled === true,
          capturedAt: input.capturedAt,
          businessDate: input.businessDate,
          policy,
          booking,
          services,
          staff,
          shifts,
          capabilities,
          occupiedBookings,
          resources,
        });
        const actual = resolveTurnIqShadowActualAssignment({
          bookingId: booking.id,
          bookingCreatedAt: booking.createdAt,
          assignedStaffId: booking.staffId,
          events: assignmentEvents,
        });
        const result = await captureTurnIqShadowTruth({
          decisionInput: trusted.decisionInput,
          actualAssignment: actual,
          observationKey: observationKey(row, policy),
          repository: turnIqShadowTruthRepository,
        });
        if (result.decisionInserted) decisionsInserted += 1;
        if (result.comparisonInserted) comparisonsInserted += 1;
      } catch (error) {
        if (error instanceof TurnIqContractError) {
          unsupported += 1;
          continue;
        }
        throw error;
      }
    }

    return {
      status: "captured",
      examined: targets.length,
      decisionsInserted,
      comparisonsInserted,
      unsupported,
    };
  } catch {
    return {
      status: "failed",
      examined: 0,
      decisionsInserted: 0,
      comparisonsInserted: 0,
      unsupported: 0,
    };
  }
}
