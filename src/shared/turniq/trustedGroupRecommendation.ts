import "server-only";

import { salonDayRangeUtc, salonYmdOfUtc } from "@/shared/lib/salonTime";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { canUseTurnIqLiveBoard } from "@/shared/turniq/access";
import { TurnIqGatewayError, type TurnIqRpcOutcome } from "@/shared/turniq/actionCore";
import {
  requestedTechTrustLabel,
  type TurnIqGroupTimingPreference,
  type TurnIqPolicyVersion,
} from "@/shared/turniq/contracts";
import { canonicalTurnIqJson, sha256TurnIqHex } from "@/shared/turniq/fingerprint";
import { decideTurnIqGroup } from "@/shared/turniq/groupMatchingEngine";
import {
  projectTurnIqGroupPlan,
  projectTurnIqGroupTimingSimulation,
  type TurnIqGroupPlanItemReadRow,
  type TurnIqGroupPlanReadRow,
  type TurnIqGroupPlanView,
  type TurnIqGroupQueueItemView,
  type TurnIqGroupQueueView,
} from "@/shared/turniq/groupReadModels";
import { simulateTurnIqGroupTiming } from "@/shared/turniq/groupTimingSimulationEngine";
import { resolveTurnIqContext } from "@/shared/turniq/serverDal";
import type {
  TurnIqGroupCommandActionResult,
  TurnIqGroupConfirmationActionInput,
  TurnIqGroupRecommendationActionInput,
  TurnIqGroupTimingComparisonActionInput,
  TurnIqGroupTimingComparisonActionResult,
  TurnIqStaggeredGroupConfirmationActionInput,
  TurnIqStaggeredGroupPlanActionInput,
  TurnIqServerActionErrorCode,
} from "@/shared/turniq/serverContracts";
import { TurnIqContractError } from "@/shared/turniq/singleCustomerEngine";
import {
  buildTrustedTurnIqGroupDecisionInput,
  type TurnIqTrustedGroupBooking,
} from "@/shared/turniq/trustedGroupSnapshot";
import type {
  TurnIqTrustedCapability,
  TurnIqTrustedOccupiedBooking,
  TurnIqTrustedResource,
  TurnIqTrustedService,
  TurnIqTrustedShift,
  TurnIqTrustedStaff,
} from "@/shared/turniq/trustedSnapshot";

type Row = Record<string, unknown>;
type DatabaseError = { code?: string; message?: string } | null;
type GroupReadResult =
  | { ok: true; data: TurnIqGroupPlanView }
  | { ok: false; code: TurnIqServerActionErrorCode };
type GroupQueueReadResult =
  | { ok: true; data: TurnIqGroupQueueView }
  | { ok: false; code: TurnIqServerActionErrorCode };

function databaseError(error: DatabaseError): TurnIqGatewayError {
  if (error?.code === "42501") return new TurnIqGatewayError("forbidden");
  if (error?.code === "23505") {
    return new TurnIqGatewayError("idempotency_conflict");
  }
  if (
    error?.code === "40001" ||
    error?.code === "55000" ||
    error?.code === "23P01" ||
    error?.code === "23514"
  ) {
    return new TurnIqGatewayError("stale_state");
  }
  return new TurnIqGatewayError("server_error");
}

function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new TurnIqGatewayError("stale_state");
  }
  return value;
}

function nullableString(row: Row, key: string): string | null {
  return typeof row[key] === "string" ? String(row[key]) : null;
}

function safeInteger(row: Row, key: string, fallback = 0): number {
  return Number.isSafeInteger(row[key]) ? Number(row[key]) : fallback;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
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

function receiptsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const id = (entry as Row).fairness_receipt_id;
    return typeof id === "string" ? [id] : [];
  });
}

function resultFromRpc(outcome: TurnIqRpcOutcome): TurnIqGroupCommandActionResult {
  if (
    !outcome.ok ||
    !outcome.command_id ||
    !outcome.group_plan_id ||
    !outcome.booking_group_id ||
    !outcome.status ||
    !Number.isSafeInteger(outcome.party_size) ||
    !Number.isSafeInteger(outcome.state_version)
  ) {
    return { ok: false, code: outcome.ok ? "server_error" : "stale_state" };
  }
  return {
    ok: true,
    result: {
      commandId: outcome.command_id,
      replayed: outcome.replayed === true,
      groupPlanId: outcome.group_plan_id,
      bookingGroupId: outcome.booking_group_id,
      partySize: outcome.party_size as number,
      status: outcome.status,
      stateVersion: outcome.state_version as number,
      fairnessReceiptIds: receiptsFrom(outcome.fairness_receipts),
    },
  };
}

function outcomeFromReceipt(value: unknown): TurnIqRpcOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false };
  }
  const row = value as Row;
  return {
    ok: row.ok === true,
    command_id: nullableString(row, "command_id") ?? undefined,
    replayed: true,
    group_plan_id: nullableString(row, "group_plan_id") ?? undefined,
    booking_group_id: nullableString(row, "booking_group_id") ?? undefined,
    party_size: Number.isSafeInteger(row.party_size)
      ? Number(row.party_size)
      : undefined,
    status: nullableString(row, "status") ?? undefined,
    state_version: Number.isSafeInteger(row.state_version)
      ? Number(row.state_version)
      : undefined,
    fairness_receipts: row.fairness_receipts,
  };
}

function mapFailure(error: unknown): TurnIqGroupCommandActionResult {
  if (error instanceof TurnIqGatewayError) {
    return { ok: false, code: error.code };
  }
  if (error instanceof TurnIqContractError) {
    return { ok: false, code: "stale_state" };
  }
  return { ok: false, code: "server_error" };
}

async function replayGroupCommand(input: {
  commandId: string;
  salonId: string;
  deviceId: string;
  localSequence: number;
  actorUserId: string;
  actorRole: string;
  commandType: "recommend_group" | "confirm_group";
  requestFingerprint?: string;
}): Promise<TurnIqGroupCommandActionResult | null> {
  const { data, error } = await createServiceRoleClient()
    .from("turniq_command_receipts" as never)
    .select(
      "salon_id, device_id, local_sequence, actor_user_id, actor_role, command_type, request_fingerprint, result" as never,
    )
    .eq("command_id" as never, input.commandId)
    .maybeSingle();
  if (error) throw databaseError(error);
  if (!data) return null;
  const row = data as unknown as Row;
  if (
    row.salon_id !== input.salonId ||
    row.device_id !== input.deviceId ||
    safeInteger(row, "local_sequence", -1) !== input.localSequence ||
    row.actor_user_id !== input.actorUserId ||
    row.actor_role !== input.actorRole ||
    row.command_type !== input.commandType ||
    (input.requestFingerprint !== undefined &&
      row.request_fingerprint !== input.requestFingerprint)
  ) {
    return { ok: false, code: "idempotency_conflict" };
  }
  return resultFromRpc(outcomeFromReceipt(row.result));
}

type ResolvedTurnIqContext = NonNullable<
  Awaited<ReturnType<typeof resolveTurnIqContext>>
>;

type TrustedGroupDecisionContext = {
  db: ReturnType<typeof createServiceRoleClient>;
  policy: TurnIqPolicyVersion;
  bookings: readonly TurnIqTrustedGroupBooking[];
  trusted: Awaited<ReturnType<typeof buildTrustedTurnIqGroupDecisionInput>>;
};

function timingPreference(input: {
  intent: "start_together" | "finish_together" | "smart_wave";
  windowMinutes: number;
  finishOffsetMinutes: number;
  requestedStartAt: string;
}): TurnIqGroupTimingPreference {
  const requestedStartMs = Date.parse(input.requestedStartAt);
  if (!Number.isFinite(requestedStartMs)) {
    throw new TurnIqContractError("turniq_invalid_requested_start");
  }
  if (input.intent === "finish_together") {
    return {
      intent: "finish_together",
      targetFinishAt: new Date(
        requestedStartMs + input.finishOffsetMinutes * 60_000,
      ).toISOString(),
    };
  }
  return {
    intent: input.intent,
    latestStartAt: new Date(
      requestedStartMs + input.windowMinutes * 60_000,
    ).toISOString(),
    cadenceMinutes: 5,
  };
}

/** Shared read-only snapshot loader for M4C recommendation and M4F simulation. */
async function loadTrustedGroupDecisionContext(input: {
  context: ResolvedTurnIqContext;
  bookingGroupId: string;
  capturedAt: string;
}): Promise<TrustedGroupDecisionContext> {
  const { context, bookingGroupId, capturedAt } = input;
  const db = createServiceRoleClient();
  const [salonResult, bookingResult] = await Promise.all([
    db
      .from("salons")
      .select("id, timezone, resources_enabled")
      .eq("id", context.salonId)
      .maybeSingle(),
    db
      .from("bookings")
      .select(
        "id, salon_id, group_id, service_id, addon_service_id, staff_id, start_time_utc, end_time_utc, status, schedule_model, resource_id, deleted_at",
      )
      .eq("salon_id", context.salonId)
      .eq("group_id", bookingGroupId)
      .is("deleted_at", null),
  ]);
  if (salonResult.error) throw databaseError(salonResult.error);
  if (bookingResult.error) throw databaseError(bookingResult.error);
  if (!salonResult.data) throw new TurnIqGatewayError("not_found");
  const activeBookingRows = ((bookingResult.data ?? []) as unknown as Row[])
    .filter(
      (row) =>
        !["cancelled", "no_show", "completed"].includes(String(row.status)),
    );
  if (activeBookingRows.length < 2 || activeBookingRows.length > 12) {
    throw new TurnIqGatewayError("not_found");
  }
  const salon = salonResult.data as unknown as Row;
  const timezone = requiredString(salon, "timezone");
  const businessDate = salonYmdOfUtc(capturedAt, timezone);
  const firstStart = requiredString(activeBookingRows[0], "start_time_utc");
  if (salonYmdOfUtc(firstStart, timezone) !== businessDate) {
    throw new TurnIqGatewayError("stale_state");
  }
  const { startUtc, endUtc } = salonDayRangeUtc(businessDate, timezone);
  const policyResult = await db
    .from("turniq_policy_versions" as never)
    .select(
      "id, salon_id, version, policy_name, business_timezone, effective_business_date, fairness_band_cents" as never,
    )
    .eq("salon_id" as never, context.salonId)
    .lte("effective_business_date" as never, businessDate)
    .order("effective_business_date" as never, { ascending: false })
    .order("version" as never, { ascending: false })
    .limit(1)
    .maybeSingle();
  if (policyResult.error) throw databaseError(policyResult.error);
  if (!policyResult.data) throw new TurnIqGatewayError("stale_state");
  const policy = policyFromRow(policyResult.data as unknown as Row);
  if (policy.timezone !== timezone) {
    throw new TurnIqGatewayError("stale_state");
  }

  const bookingIds = activeBookingRows.map((row) => requiredString(row, "id"));
  const serviceIds = [
    ...new Set(
      activeBookingRows
        .flatMap((row) => [
          requiredString(row, "service_id"),
          nullableString(row, "addon_service_id"),
        ])
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const [
    servicesResult,
    staffResult,
    shiftResult,
    capabilityResult,
    occupiedResult,
    segmentResult,
    resourceResult,
    addonResult,
  ] = await Promise.all([
    db
      .from("services")
      .select(
        "id, name, price_cents, duration_minutes, buffer_minutes, is_addon, resource_requirement_mode, required_resource_kinds",
      )
      .eq("salon_id", context.salonId)
      .in("id", serviceIds)
      .is("deleted_at", null),
    db
      .from("staff")
      .select("id, name, status")
      .eq("salon_id", context.salonId)
      .is("deleted_at", null),
    db
      .from("turniq_shift_sessions" as never)
      .select(
        "id, policy_version_id, staff_id, business_date, checked_in_at, state, queue_position, fairness_baseline_cents, service_credit_since_checkin_cents, state_version" as never,
      )
      .eq("salon_id" as never, context.salonId)
      .eq("policy_version_id" as never, policy.policyId)
      .eq("business_date" as never, businessDate)
      .is("checked_out_at" as never, null),
    db.from("staff_services").select("staff_id, service_id").in("service_id", serviceIds),
    db
      .from("bookings")
      .select("id, staff_id, resource_id, start_time_utc, end_time_utc, status")
      .eq("salon_id", context.salonId)
      .is("deleted_at", null)
      .lt("start_time_utc", endUtc)
      .gt("end_time_utc", startUtc)
      .in("status", ["pending", "confirmed", "in_progress"]),
    db
      .from("booking_service_segments" as never)
      .select(
        "id, booking_id, staff_id, resource_id, occupied_start_utc, occupied_end_utc, reservation_status" as never,
      )
      .eq("salon_id" as never, context.salonId)
      .lt("occupied_start_utc" as never, endUtc)
      .gt("occupied_end_utc" as never, startUtc)
      .in("reservation_status" as never, [
        "pending",
        "confirmed",
        "in_progress",
      ]),
    db
      .from("salon_resources")
      .select("id, name, kind, status")
      .eq("salon_id", context.salonId)
      .is("deleted_at", null),
    db.from("booking_addons").select("id, booking_id").in("booking_id", bookingIds),
  ]);
  for (const result of [
    servicesResult,
    staffResult,
    shiftResult,
    capabilityResult,
    occupiedResult,
    segmentResult,
    resourceResult,
    addonResult,
  ]) {
    if (result.error) throw databaseError(result.error);
  }

  const addonBookingIds = new Set(
    ((addonResult.data ?? []) as unknown as Row[]).map((row) =>
      requiredString(row, "booking_id"),
    ),
  );
  const segmentRows = (segmentResult.data ?? []) as unknown as Row[];
  const segmentedBookingIds = new Set(
    segmentRows
      .filter((row) => typeof row.booking_id === "string")
      .map((row) => String(row.booking_id)),
  );
  const bookings: TurnIqTrustedGroupBooking[] = activeBookingRows.map((row) => ({
    id: requiredString(row, "id"),
    salonId: requiredString(row, "salon_id"),
    groupId: requiredString(row, "group_id"),
    serviceId: requiredString(row, "service_id"),
    addonServiceId: nullableString(row, "addon_service_id"),
    staffId: nullableString(row, "staff_id"),
    startAt: requiredString(row, "start_time_utc"),
    endAt: requiredString(row, "end_time_utc"),
    status: requiredString(row, "status") as TurnIqTrustedGroupBooking["status"],
    scheduleModel: requiredString(row, "schedule_model"),
    resourceId: nullableString(row, "resource_id"),
    hasBookingAddonRows: addonBookingIds.has(requiredString(row, "id")),
    hasServiceSegments: segmentedBookingIds.has(requiredString(row, "id")),
  }));
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
  const shifts: TurnIqTrustedShift[] = ((shiftResult.data ?? []) as unknown as Row[]).map(
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
  const capabilities: TurnIqTrustedCapability[] = ((capabilityResult.data ?? []) as unknown as Row[]).map(
    (row) => ({
      staffId: requiredString(row, "staff_id"),
      serviceId: requiredString(row, "service_id"),
    }),
  );
  const occupiedBookings: TurnIqTrustedOccupiedBooking[] = [
    ...((occupiedResult.data ?? []) as unknown as Row[]).map((row) => ({
      id: requiredString(row, "id"),
      staffId: nullableString(row, "staff_id"),
      resourceId: nullableString(row, "resource_id"),
      startAt: requiredString(row, "start_time_utc"),
      endAt: requiredString(row, "end_time_utc"),
      status: requiredString(row, "status"),
    })),
    ...segmentRows.map((row) => ({
      id: `segment:${requiredString(row, "id")}`,
      staffId: nullableString(row, "staff_id"),
      resourceId: nullableString(row, "resource_id"),
      startAt: requiredString(row, "occupied_start_utc"),
      endAt: requiredString(row, "occupied_end_utc"),
      status: requiredString(row, "reservation_status"),
    })),
  ];
  const resources: TurnIqTrustedResource[] = ((resourceResult.data ?? []) as unknown as Row[]).map(
    (row) => ({
      id: requiredString(row, "id"),
      kind: requiredString(row, "kind"),
      active: row.status === "active",
    }),
  );
  const trusted = await buildTrustedTurnIqGroupDecisionInput({
    salonId: context.salonId,
    resourcesEnabled: salon.resources_enabled === true,
    capturedAt,
    businessDate,
    policy,
    bookingGroupId,
    bookings,
    services,
    staff,
    shifts,
    capabilities,
    occupiedBookings,
    resources,
  });
  return { db, policy, bookings, trusted };
}

/**
 * M4C server-owned adapter. The browser can identify a booking group but cannot
 * nominate staff/resources, alter policy, supply scores or inject traces.
 */
export async function recommendTrustedTurnIqGroup(
  input: TurnIqGroupRecommendationActionInput,
  now: () => string = () => new Date().toISOString(),
): Promise<TurnIqGroupCommandActionResult> {
  try {
    const context = await resolveTurnIqContext(input.slug);
    if (!context) return { ok: false, code: "unauthorized" };
    if (!context.featureEnabled) return { ok: false, code: "feature_disabled" };
    if (!canUseTurnIqLiveBoard(context.role)) {
      return { ok: false, code: "forbidden" };
    }
    const replay = await replayGroupCommand({
      ...input,
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      actorRole: context.actorRole,
      commandType: "recommend_group",
    });
    if (replay) return replay;

    const capturedAt = now();
    const { db, policy, bookings, trusted } =
      await loadTrustedGroupDecisionContext({
        context,
        bookingGroupId: input.bookingGroupId,
        capturedAt,
      });
    const decision = await decideTurnIqGroup(trusted.decisionInput);
    if (
      decision.salonId !== context.salonId ||
      decision.policyId !== policy.policyId ||
      !decision.objectiveScore ||
      !decision.conservativeEta ||
      decision.assignments.length !== bookings.length
    ) {
      return { ok: false, code: "stale_state" };
    }
    const bookingById = new Map(bookings.map((booking) => [booking.id, booking]));
    for (const assignment of decision.assignments) {
      const booking = bookingById.get(assignment.taskId);
      // M4B confirms the booked simultaneous slot atomically. Staggered group
      // waves are deliberately deferred instead of silently moving bookings.
      if (
        !booking ||
        assignment.startsAt !== new Date(booking.startAt).toISOString() ||
        assignment.resourceIds.length > 1
      ) {
        return { ok: false, code: "stale_state" };
      }
      if (
        booking.resourceId &&
        assignment.resourceIds[0] !== booking.resourceId
      ) {
        return { ok: false, code: "stale_state" };
      }
    }
    const requestFingerprint = await sha256TurnIqHex(
      canonicalTurnIqJson({
        kind: "turniq_group_recommendation_command_v1",
        salonId: context.salonId,
        actorUserId: context.actorUserId,
        policyVersionId: policy.policyId,
        bookingGroupId: input.bookingGroupId,
        bookingIds: trusted.bookingIds,
        commandId: input.commandId,
        deviceId: input.deviceId,
        localSequence: input.localSequence,
      }),
    );
    const items = decision.assignments.map((assignment) => ({
      taskRef: assignment.taskId,
      bookingId: assignment.taskId,
      customerRequestId: assignment.taskId,
      recommendedStaffId: assignment.staffId,
      resourceId: assignment.resourceIds[0] ?? null,
      requestedStaffId: null,
      requestedTechSource: null,
      requestTrustLabel: null,
      requestedTechActorRef: null,
      requestedTechRecordedAt: null,
      startsAt: assignment.startsAt,
      safeEndAt: assignment.releasesAt,
      requestedFallback: assignment.requestedTechnicianSatisfied === false,
      waitMinutes: assignment.waitMinutes,
      explanation: decision.privacySafeExplanation,
      eligibleCandidates: [],
      skippedCandidates: [],
      internalDecisionTrace: {
        source: "trusted_server_group_snapshot_v1",
        groupReasonCodes: decision.reasonCodes,
        assignmentReasonCodes: assignment.reasonCodes,
        evaluatedSearchStates: decision.evaluatedSearchStates,
      },
    }));
    const { data, error } = await db.rpc(
      "record_turniq_group_plan_v1" as never,
      {
        p_salon_id: context.salonId,
        p_policy_version_id: policy.policyId,
        p_booking_group_id: input.bookingGroupId,
        p_decision_timestamp: decision.decidedAt,
        p_decision_fingerprint: decision.fingerprint,
        p_snapshot_version: decision.snapshotVersion,
        p_privacy_safe_explanation: decision.privacySafeExplanation,
        p_objective_score: decision.objectiveScore,
        p_conservative_eta: decision.conservativeEta,
        p_items: items,
        p_command_id: input.commandId,
        p_device_id: input.deviceId,
        p_local_sequence: input.localSequence,
        p_actor_user_id: context.actorUserId,
        p_actor_role: context.actorRole,
        p_request_fingerprint: requestFingerprint,
        p_occurred_at: capturedAt,
      } as never,
    );
    if (error) throw databaseError(error);
    return resultFromRpc(data as unknown as TurnIqRpcOutcome);
  } catch (error) {
    return mapFailure(error);
  }
}

/**
 * M4F read-only comparison. All three options share one authoritative snapshot;
 * no plan, booking, receipt, command or provider state is written.
 */
export async function compareTrustedTurnIqGroupTiming(
  input: TurnIqGroupTimingComparisonActionInput,
  now: () => string = () => new Date().toISOString(),
): Promise<TurnIqGroupTimingComparisonActionResult> {
  try {
    const context = await resolveTurnIqContext(input.slug);
    if (!context) return { ok: false, code: "unauthorized" };
    if (!context.featureEnabled) return { ok: false, code: "feature_disabled" };
    if (!canUseTurnIqLiveBoard(context.role)) {
      return { ok: false, code: "forbidden" };
    }
    const capturedAt = now();
    const { trusted } = await loadTrustedGroupDecisionContext({
      context,
      bookingGroupId: input.bookingGroupId,
      capturedAt,
    });
    const requestedStartAt = trusted.decisionInput.request.requestedStartAt;
    const simulations = await Promise.all([
      simulateTurnIqGroupTiming({
        decisionInput: trusted.decisionInput,
        timing: timingPreference({ ...input, intent: "start_together", requestedStartAt }),
      }),
      simulateTurnIqGroupTiming({
        decisionInput: trusted.decisionInput,
        timing: timingPreference({ ...input, intent: "finish_together", requestedStartAt }),
      }),
      simulateTurnIqGroupTiming({
        decisionInput: trusted.decisionInput,
        timing: timingPreference({ ...input, intent: "smart_wave", requestedStartAt }),
      }),
    ]);
    return {
      ok: true,
      data: {
        bookingGroupId: input.bookingGroupId,
        snapshotVersion: trusted.decisionInput.snapshot.snapshotVersion,
        comparedAt: capturedAt,
        windowMinutes: input.windowMinutes,
        finishOffsetMinutes: input.finishOffsetMinutes,
        liveStateChanged: false,
        options: simulations.map((simulation) =>
          projectTurnIqGroupTimingSimulation({
            simulation,
            decisionInput: trusted.decisionInput,
          }),
        ),
      },
    };
  } catch (error) {
    if (error instanceof TurnIqGatewayError) {
      return { ok: false, code: error.code };
    }
    if (error instanceof TurnIqContractError) {
      return { ok: false, code: "stale_state" };
    }
    return { ok: false, code: "server_error" };
  }
}

/**
 * M4H supervised bridge. Rebuilds the exact option shown to the desk from a
 * fresh database read while pinning the original comparison timestamp. If any
 * material row changed, the snapshot/simulation fingerprints no longer match
 * and no plan is recorded.
 */
export async function recordTrustedTurnIqStaggeredGroupPlan(
  input: TurnIqStaggeredGroupPlanActionInput,
  now: () => string = () => new Date().toISOString(),
): Promise<TurnIqGroupCommandActionResult> {
  try {
    const context = await resolveTurnIqContext(input.slug);
    if (!context) return { ok: false, code: "unauthorized" };
    if (!context.featureEnabled) return { ok: false, code: "feature_disabled" };
    if (!canUseTurnIqLiveBoard(context.role)) {
      return { ok: false, code: "forbidden" };
    }
    const replayFingerprint = await sha256TurnIqHex(
      canonicalTurnIqJson({
        kind: "turniq_staggered_group_selection_command_v1",
        salonId: context.salonId,
        actorUserId: context.actorUserId,
        bookingGroupId: input.bookingGroupId,
        intent: input.intent,
        windowMinutes: input.windowMinutes,
        finishOffsetMinutes: input.finishOffsetMinutes,
        simulationId: input.expectedSimulationId,
        simulationFingerprint: input.expectedSimulationFingerprint,
        snapshotVersion: input.expectedSnapshotVersion,
        comparedAt: input.comparedAt,
        commandId: input.commandId,
        deviceId: input.deviceId,
        localSequence: input.localSequence,
      }),
    );
    const replay = await replayGroupCommand({
      ...input,
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      actorRole: context.actorRole,
      commandType: "recommend_group",
      requestFingerprint: replayFingerprint,
    });
    if (replay) return replay;
    const occurredAt = now();
    const comparedAtMs = Date.parse(input.comparedAt);
    const occurredAtMs = Date.parse(occurredAt);
    if (
      !Number.isFinite(comparedAtMs) ||
      !Number.isFinite(occurredAtMs) ||
      comparedAtMs > occurredAtMs + 30_000 ||
      occurredAtMs - comparedAtMs > 5 * 60_000
    ) {
      return { ok: false, code: "stale_state" };
    }

    const { db, policy, bookings, trusted } =
      await loadTrustedGroupDecisionContext({
        context,
        bookingGroupId: input.bookingGroupId,
        capturedAt: input.comparedAt,
      });
    if (
      trusted.decisionInput.snapshot.snapshotVersion !==
      input.expectedSnapshotVersion
    ) {
      return { ok: false, code: "stale_state" };
    }
    const simulation = await simulateTurnIqGroupTiming({
      decisionInput: trusted.decisionInput,
      timing: timingPreference({
        ...input,
        requestedStartAt: trusted.decisionInput.request.requestedStartAt,
      }),
    });
    if (
      simulation.intent !== input.intent ||
      simulation.simulationId !== input.expectedSimulationId ||
      simulation.fingerprint !== input.expectedSimulationFingerprint ||
      simulation.snapshotVersion !== input.expectedSnapshotVersion ||
      simulation.assignments.length !== bookings.length ||
      !simulation.objectiveScore ||
      !simulation.conservativeEta
    ) {
      return { ok: false, code: "stale_state" };
    }

    const taskById = new Map(
      trusted.decisionInput.request.tasks.map((task) => [task.taskId, task]),
    );
    const items = simulation.assignments.map((assignment) => {
      const requested = taskById.get(assignment.taskId)?.requestedTechnician ?? null;
      return {
        taskRef: assignment.taskId,
        bookingId: assignment.taskId,
        customerRequestId: assignment.taskId,
        recommendedStaffId: assignment.staffId,
        resourceId: assignment.resourceIds[0] ?? null,
        requestedStaffId: requested?.staffId ?? null,
        requestedTechSource: requested?.source ?? null,
        requestTrustLabel: requested
          ? requestedTechTrustLabel(requested.source)
          : null,
        requestedTechActorRef: requested ? `user:${requested.actorId}` : null,
        requestedTechRecordedAt: requested?.recordedAt ?? null,
        startsAt: assignment.startsAt,
        safeEndAt: assignment.releasesAt,
        requestedFallback: assignment.requestedTechnicianSatisfied === false,
        waitMinutes: assignment.waitMinutes,
        waveNumber: assignment.waveNumber,
        explanation: simulation.privacySafeExplanation,
        eligibleCandidates: [],
        skippedCandidates: [],
        internalDecisionTrace: {
          source: "trusted_server_group_timing_snapshot_v1",
          timingReasonCodes: simulation.reasonCodes,
          assignmentReasonCodes: assignment.reasonCodes,
          evaluatedSearchStates: simulation.evaluatedSearchStates,
        },
      };
    });
    const decisionFingerprint = await sha256TurnIqHex(
      canonicalTurnIqJson({
        kind: "turniq_staggered_group_plan_decision_v1",
        simulationFingerprint: simulation.fingerprint,
        assignments: simulation.assignments,
      }),
    );
    const { data, error } = await db.rpc(
      "record_turniq_staggered_group_plan_v1" as never,
      {
        p_salon_id: context.salonId,
        p_policy_version_id: policy.policyId,
        p_booking_group_id: input.bookingGroupId,
        p_requested_start_at: trusted.decisionInput.request.requestedStartAt,
        p_timing_intent: simulation.intent,
        p_simulation_id: simulation.simulationId,
        p_simulation_fingerprint: simulation.fingerprint,
        p_decision_timestamp: occurredAt,
        p_decision_fingerprint: decisionFingerprint,
        p_snapshot_version: simulation.snapshotVersion,
        p_privacy_safe_explanation: simulation.privacySafeExplanation,
        p_objective_score: simulation.objectiveScore,
        p_conservative_eta: simulation.conservativeEta,
        p_items: items,
        p_command_id: input.commandId,
        p_device_id: input.deviceId,
        p_local_sequence: input.localSequence,
        p_actor_user_id: context.actorUserId,
        p_actor_role: context.actorRole,
        p_request_fingerprint: replayFingerprint,
        p_occurred_at: occurredAt,
      } as never,
    );
    if (error) throw databaseError(error);
    return resultFromRpc(data as unknown as TurnIqRpcOutcome);
  } catch (error) {
    return mapFailure(error);
  }
}

export async function confirmTrustedTurnIqStaggeredGroupPlan(
  input: TurnIqStaggeredGroupConfirmationActionInput,
  now: () => string = () => new Date().toISOString(),
): Promise<TurnIqGroupCommandActionResult> {
  try {
    const context = await resolveTurnIqContext(input.slug);
    if (!context) return { ok: false, code: "unauthorized" };
    if (!context.featureEnabled) return { ok: false, code: "feature_disabled" };
    if (!canUseTurnIqLiveBoard(context.role)) {
      return { ok: false, code: "forbidden" };
    }
    const db = createServiceRoleClient();
    const { data: planData, error: planError } = await db
      .from("turniq_group_plans" as never)
      .select("id, salon_id, policy_version_id, status, state_version, planning_mode" as never)
      .eq("id" as never, input.groupPlanId)
      .eq("salon_id" as never, context.salonId)
      .maybeSingle();
    if (planError) throw databaseError(planError);
    if (!planData) return { ok: false, code: "not_found" };
    const plan = planData as unknown as Row;
    const policyVersionId = requiredString(plan, "policy_version_id");
    const occurredAt = now();
    const requestFingerprint = await sha256TurnIqHex(
      canonicalTurnIqJson({
        kind: "turniq_staggered_group_confirmation_command_v1",
        salonId: context.salonId,
        actorUserId: context.actorUserId,
        policyVersionId,
        groupPlanId: input.groupPlanId,
        expectedStateVersion: input.expectedStateVersion,
        overrideReason: input.overrideReason ?? null,
        commandId: input.commandId,
        deviceId: input.deviceId,
        localSequence: input.localSequence,
      }),
    );
    const replay = await replayGroupCommand({
      ...input,
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      actorRole: context.actorRole,
      commandType: "confirm_group",
      requestFingerprint,
    });
    if (replay) return replay;
    if (
      plan.planning_mode !== "staggered" ||
      plan.status !== "recommended" ||
      safeInteger(plan, "state_version") !== input.expectedStateVersion
    ) {
      return { ok: false, code: "stale_state" };
    }
    const { data, error } = await db.rpc(
      "confirm_turniq_staggered_group_plan_v1" as never,
      {
        p_salon_id: context.salonId,
        p_policy_version_id: policyVersionId,
        p_group_plan_id: input.groupPlanId,
        p_expected_state_version: input.expectedStateVersion,
        p_override_reason: input.overrideReason ?? null,
        p_command_id: input.commandId,
        p_device_id: input.deviceId,
        p_local_sequence: input.localSequence,
        p_actor_user_id: context.actorUserId,
        p_actor_role: context.actorRole,
        p_request_fingerprint: requestFingerprint,
        p_occurred_at: occurredAt,
      } as never,
    );
    if (error) throw databaseError(error);
    return resultFromRpc(data as unknown as TurnIqRpcOutcome);
  } catch (error) {
    return mapFailure(error);
  }
}

export async function confirmTrustedTurnIqGroup(
  input: TurnIqGroupConfirmationActionInput,
  now: () => string = () => new Date().toISOString(),
): Promise<TurnIqGroupCommandActionResult> {
  try {
    const context = await resolveTurnIqContext(input.slug);
    if (!context) return { ok: false, code: "unauthorized" };
    if (!context.featureEnabled) return { ok: false, code: "feature_disabled" };
    if (!canUseTurnIqLiveBoard(context.role)) {
      return { ok: false, code: "forbidden" };
    }
    const replay = await replayGroupCommand({
      ...input,
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      actorRole: context.actorRole,
      commandType: "confirm_group",
    });
    if (replay) return replay;

    const db = createServiceRoleClient();
    const { data: planData, error: planError } = await db
      .from("turniq_group_plans" as never)
      .select("id, salon_id, policy_version_id, status" as never)
      .eq("id" as never, input.groupPlanId)
      .eq("salon_id" as never, context.salonId)
      .maybeSingle();
    if (planError) throw databaseError(planError);
    if (!planData) return { ok: false, code: "not_found" };
    const plan = planData as unknown as Row;
    if (plan.status !== "recommended") {
      return { ok: false, code: "stale_state" };
    }
    const { data: itemData, error: itemError } = await db
      .from("turniq_group_plan_items" as never)
      .select("requested_fallback" as never)
      .eq("salon_id" as never, context.salonId)
      .eq("group_plan_id" as never, input.groupPlanId);
    if (itemError) throw databaseError(itemError);
    const hasFallback = ((itemData ?? []) as unknown as Row[]).some(
      (row) => row.requested_fallback === true,
    );
    if (hasFallback && !input.overrideReason) {
      return { ok: false, code: "owner_confirmation_required" };
    }
    const occurredAt = now();
    const policyVersionId = requiredString(plan, "policy_version_id");
    const requestFingerprint = await sha256TurnIqHex(
      canonicalTurnIqJson({
        kind: "turniq_group_confirmation_command_v1",
        salonId: context.salonId,
        actorUserId: context.actorUserId,
        policyVersionId,
        groupPlanId: input.groupPlanId,
        overrideReason: input.overrideReason ?? null,
        commandId: input.commandId,
        deviceId: input.deviceId,
        localSequence: input.localSequence,
      }),
    );
    const { data, error } = await db.rpc(
      "confirm_turniq_group_plan_v1" as never,
      {
        p_salon_id: context.salonId,
        p_policy_version_id: policyVersionId,
        p_group_plan_id: input.groupPlanId,
        p_override_reason: input.overrideReason ?? null,
        p_command_id: input.commandId,
        p_device_id: input.deviceId,
        p_local_sequence: input.localSequence,
        p_actor_user_id: context.actorUserId,
        p_actor_role: context.actorRole,
        p_request_fingerprint: requestFingerprint,
        p_occurred_at: occurredAt,
      } as never,
    );
    if (error) throw databaseError(error);
    return resultFromRpc(data as unknown as TurnIqRpcOutcome);
  } catch (error) {
    return mapFailure(error);
  }
}

export async function loadTrustedTurnIqGroupPlan(
  slug: string,
  groupPlanId: string,
): Promise<GroupReadResult> {
  try {
    const context = await resolveTurnIqContext(slug);
    if (!context) return { ok: false, code: "unauthorized" };
    if (!context.featureEnabled) return { ok: false, code: "feature_disabled" };
    if (!canUseTurnIqLiveBoard(context.role)) {
      return { ok: false, code: "forbidden" };
    }
    const db = createServiceRoleClient();
    const [planResult, itemResult] = await Promise.all([
      db
        .from("turniq_group_plans" as never)
        .select(
          "id, booking_group_id, party_size, requested_start_at, decision_timestamp, privacy_safe_explanation, conservative_eta, status, state_version, planning_mode, timing_intent" as never,
        )
        .eq("salon_id" as never, context.salonId)
        .eq("id" as never, groupPlanId)
        .maybeSingle(),
      db
        .from("turniq_group_plan_items" as never)
        .select(
          "item_position, assignment_id, booking_id, proposed_staff_id, proposed_resource_id, starts_at, safe_end_at, requested_fallback, wait_minutes, wave_number" as never,
        )
        .eq("salon_id" as never, context.salonId)
        .eq("group_plan_id" as never, groupPlanId)
        .order("item_position" as never, { ascending: true }),
    ]);
    if (planResult.error) throw databaseError(planResult.error);
    if (itemResult.error) throw databaseError(itemResult.error);
    if (!planResult.data) return { ok: false, code: "not_found" };
    const planRow = planResult.data as unknown as Row;
    const itemRows = (itemResult.data ?? []) as unknown as Row[];
    const assignmentIds = itemRows.map((row) => requiredString(row, "assignment_id"));
    if (assignmentIds.length === 0) return { ok: false, code: "stale_state" };
    const [assignmentResult, receiptResult] = await Promise.all([
      db
        .from("turniq_assignments" as never)
        .select("id, service_id, status" as never)
        .eq("salon_id" as never, context.salonId)
        .in("id" as never, assignmentIds),
      db
        .from("turniq_fairness_receipts" as never)
        .select("id, assignment_id" as never)
        .eq("salon_id" as never, context.salonId)
        .in("assignment_id" as never, assignmentIds),
    ]);
    if (assignmentResult.error) throw databaseError(assignmentResult.error);
    if (receiptResult.error) throw databaseError(receiptResult.error);
    const assignments = new Map(
      ((assignmentResult.data ?? []) as unknown as Row[]).map((row) => [
        requiredString(row, "id"),
        row,
      ]),
    );
    const receipts = new Map(
      ((receiptResult.data ?? []) as unknown as Row[]).map((row) => [
        requiredString(row, "assignment_id"),
        requiredString(row, "id"),
      ]),
    );
    const staffIds = [...new Set(itemRows.map((row) => requiredString(row, "proposed_staff_id")))];
    const resourceIds = [...new Set(itemRows.map((row) => nullableString(row, "proposed_resource_id")).filter((id): id is string => Boolean(id)))];
    const serviceIds = [...new Set([...assignments.values()].map((row) => requiredString(row, "service_id")))];
    const [staffResult, serviceResult, resourceResult] = await Promise.all([
      db.from("staff").select("id, name").eq("salon_id", context.salonId).in("id", staffIds),
      db.from("services").select("id, name").eq("salon_id", context.salonId).in("id", serviceIds),
      resourceIds.length > 0
        ? db.from("salon_resources").select("id, name").eq("salon_id", context.salonId).in("id", resourceIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    for (const result of [staffResult, serviceResult, resourceResult]) {
      if (result.error) throw databaseError(result.error);
    }
    const plan: TurnIqGroupPlanReadRow = {
      id: requiredString(planRow, "id"),
      bookingGroupId: requiredString(planRow, "booking_group_id"),
      partySize: safeInteger(planRow, "party_size"),
      requestedStartAt: requiredString(planRow, "requested_start_at"),
      decisionTimestamp: requiredString(planRow, "decision_timestamp"),
      privacySafeExplanation: requiredString(
        planRow,
        "privacy_safe_explanation",
      ),
      conservativeEta: planRow.conservative_eta,
      status: requiredString(planRow, "status"),
      stateVersion: safeInteger(planRow, "state_version"),
      planningMode:
        planRow.planning_mode === "staggered" ? "staggered" : "fixed",
      timingIntent:
        planRow.timing_intent === "start_together" ||
        planRow.timing_intent === "finish_together" ||
        planRow.timing_intent === "smart_wave"
          ? planRow.timing_intent
          : null,
    };
    const items: TurnIqGroupPlanItemReadRow[] = itemRows.map((row) => {
      const assignmentId = requiredString(row, "assignment_id");
      const assignment = assignments.get(assignmentId);
      if (!assignment) throw new TurnIqGatewayError("stale_state");
      return {
        assignmentId,
        bookingId: requiredString(row, "booking_id"),
        staffId: requiredString(row, "proposed_staff_id"),
        serviceId: requiredString(assignment, "service_id"),
        resourceId: nullableString(row, "proposed_resource_id"),
        startsAt: requiredString(row, "starts_at"),
        safeEndAt: requiredString(row, "safe_end_at"),
        requestedFallback: row.requested_fallback === true,
        waitMinutes: safeInteger(row, "wait_minutes"),
        assignmentStatus: requiredString(assignment, "status"),
        fairnessReceiptId: receipts.get(assignmentId) ?? null,
        waveNumber: Number.isSafeInteger(row.wave_number)
          ? Number(row.wave_number)
          : null,
      };
    });
    return {
      ok: true,
      data: projectTurnIqGroupPlan({
        plan,
        items,
        staff: ((staffResult.data ?? []) as unknown as Row[]).map((row) => ({
          id: requiredString(row, "id"),
          name: requiredString(row, "name"),
        })),
        services: ((serviceResult.data ?? []) as unknown as Row[]).map((row) => ({
          id: requiredString(row, "id"),
          name: requiredString(row, "name"),
        })),
        resources: ((resourceResult.data ?? []) as unknown as Row[]).map((row) => ({
          id: requiredString(row, "id"),
          name: requiredString(row, "name"),
        })),
      }),
    };
  } catch (error) {
    if (error instanceof TurnIqGatewayError) {
      return { ok: false, code: error.code };
    }
    return { ok: false, code: "server_error" };
  }
}

/** PII-free list of today's active booking groups that need TurnIQ desk work. */
export async function loadTrustedTurnIqGroupQueue(
  slug: string,
  now: () => string = () => new Date().toISOString(),
): Promise<GroupQueueReadResult> {
  try {
    const context = await resolveTurnIqContext(slug);
    if (!context) return { ok: false, code: "unauthorized" };
    if (!context.featureEnabled) return { ok: false, code: "feature_disabled" };
    if (!canUseTurnIqLiveBoard(context.role)) {
      return { ok: false, code: "forbidden" };
    }
    const db = createServiceRoleClient();
    const { data: salonData, error: salonError } = await db
      .from("salons")
      .select("id, timezone")
      .eq("id", context.salonId)
      .maybeSingle();
    if (salonError) throw databaseError(salonError);
    if (!salonData) return { ok: false, code: "not_found" };
    const timezone = requiredString(salonData as unknown as Row, "timezone");
    const businessDate = salonYmdOfUtc(now(), timezone);
    const { startUtc, endUtc } = salonDayRangeUtc(businessDate, timezone);
    const { data: bookingData, error: bookingError } = await db
      .from("bookings")
      .select(
        "id, group_id, service_id, staff_id, start_time_utc, status, schedule_model",
      )
      .eq("salon_id", context.salonId)
      .is("deleted_at", null)
      .not("group_id", "is", null)
      .gte("start_time_utc", startUtc)
      .lt("start_time_utc", endUtc)
      .in("status", ["pending", "confirmed", "waiting"]);
    if (bookingError) throw databaseError(bookingError);
    const rows = (bookingData ?? []) as unknown as Row[];
    if (rows.length === 0) {
      return { ok: true, data: { businessDate, groups: [] } };
    }
    const grouped = new Map<string, Row[]>();
    for (const row of rows) {
      const groupId = requiredString(row, "group_id");
      const members = grouped.get(groupId) ?? [];
      members.push(row);
      grouped.set(groupId, members);
    }
    const groupIds = [...grouped.keys()];
    const serviceIds = [
      ...new Set(rows.map((row) => requiredString(row, "service_id"))),
    ];
    const [planResult, serviceResult] = await Promise.all([
      db
        .from("turniq_group_plans" as never)
        .select("id, booking_group_id, status" as never)
        .eq("salon_id" as never, context.salonId)
        .in("booking_group_id" as never, groupIds)
        .in("status" as never, ["recommended", "confirming", "confirmed"]),
      db
        .from("services")
        .select("id, name")
        .eq("salon_id", context.salonId)
        .in("id", serviceIds),
    ]);
    if (planResult.error) throw databaseError(planResult.error);
    if (serviceResult.error) throw databaseError(serviceResult.error);
    const plans = new Map(
      ((planResult.data ?? []) as unknown as Row[]).map((row) => [
        requiredString(row, "booking_group_id"),
        row,
      ]),
    );
    const services = new Map(
      ((serviceResult.data ?? []) as unknown as Row[]).map((row) => [
        requiredString(row, "id"),
        requiredString(row, "name"),
      ]),
    );
    const groups: TurnIqGroupQueueItemView[] = [];
    for (const [bookingGroupId, members] of grouped) {
      if (members.length < 2 || members.length > 12) continue;
      const starts = new Set(
        members.map((row) => requiredString(row, "start_time_utc")),
      );
      const schedules = new Set(
        members.map((row) => requiredString(row, "schedule_model")),
      );
      const assignedCount = members.filter(
        (row) => nullableString(row, "staff_id") !== null,
      ).length;
      const readiness: TurnIqGroupQueueItemView["readiness"] =
        starts.size !== 1
          ? "mixed_start_times"
          : schedules.size !== 1 || !schedules.has("single")
            ? "unsupported_schedule"
            : assignedCount > 0
              ? "partially_assigned"
              : "ready";
      const plan = plans.get(bookingGroupId);
      // Confirmed plans no longer need a planning card after all bookings have
      // acquired authoritative staff/resource assignments.
      if (plan?.status === "confirmed" && assignedCount === members.length) {
        continue;
      }
      const serviceSummary = [
        ...new Set(
          members.map(
            (row) =>
              services.get(requiredString(row, "service_id")) ??
              "Booked service",
          ),
        ),
      ].sort(compareText).join(" · ");
      groups.push({
        bookingGroupId,
        partySize: members.length,
        requestedStartAt: [...starts].sort(compareText)[0],
        serviceSummary,
        readiness,
        existingPlanId: plan ? requiredString(plan, "id") : null,
        existingPlanStatus: plan ? requiredString(plan, "status") : null,
      });
    }
    groups.sort((left, right) => {
      const time = left.requestedStartAt.localeCompare(right.requestedStartAt);
      return time || left.bookingGroupId.localeCompare(right.bookingGroupId);
    });
    return { ok: true, data: { businessDate, groups } };
  } catch (error) {
    if (error instanceof TurnIqGatewayError) {
      return { ok: false, code: error.code };
    }
    return { ok: false, code: "server_error" };
  }
}
