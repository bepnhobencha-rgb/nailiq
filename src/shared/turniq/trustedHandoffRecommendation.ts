import "server-only";

import { salonDayRangeUtc, salonYmdOfUtc } from "@/shared/lib/salonTime";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { canUseTurnIqLiveBoard } from "@/shared/turniq/access";
import { TurnIqGatewayError } from "@/shared/turniq/actionCore";
import type { TurnIqPolicyVersion } from "@/shared/turniq/contracts";
import { canonicalTurnIqJson, sha256TurnIqHex } from "@/shared/turniq/fingerprint";
import {
  projectTurnIqHandoffPlan,
  type TurnIqHandoffPlanView,
  type TurnIqHandoffQueueView,
} from "@/shared/turniq/handoffReadModels";
import { decideTurnIqMultiTechnicianHandoff } from "@/shared/turniq/multiTechnicianHandoffEngine";
import { turnIqStageAllowsOnlineMutation } from "@/shared/turniq/rolloutStage";
import { resolveTurnIqContext } from "@/shared/turniq/serverDal";
import type {
  TurnIqHandoffCommandActionResult,
  TurnIqHandoffConfirmationActionInput,
  TurnIqHandoffPerformerActionInput,
  TurnIqHandoffRecommendationActionInput,
  TurnIqServerActionErrorCode,
} from "@/shared/turniq/serverContracts";
import { TurnIqContractError } from "@/shared/turniq/singleCustomerEngine";
import {
  buildTrustedTurnIqHandoffDecisionInput,
  type TurnIqTrustedHandoffAddon,
  type TurnIqTrustedHandoffSegment,
} from "@/shared/turniq/trustedHandoffSnapshot";
import type {
  TurnIqTrustedCapability,
  TurnIqTrustedOccupiedBooking,
  TurnIqTrustedShift,
  TurnIqTrustedStaff,
} from "@/shared/turniq/trustedSnapshot";

type Row = Record<string, unknown>;
type DatabaseError = { code?: string; message?: string } | null;
type HandoffPlanReadResult =
  | { ok: true; data: TurnIqHandoffPlanView }
  | { ok: false; code: TurnIqServerActionErrorCode };
type HandoffQueueReadResult =
  | { ok: true; data: TurnIqHandoffQueueView }
  | { ok: false; code: TurnIqServerActionErrorCode };

function databaseError(error: DatabaseError): TurnIqGatewayError {
  if (error?.code === "42501") return new TurnIqGatewayError("forbidden");
  if (error?.code === "23505") return new TurnIqGatewayError("idempotency_conflict");
  if (["40001", "55000", "23P01", "23514"].includes(error?.code ?? "")) {
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

function policyFromRow(row: Row): TurnIqPolicyVersion {
  return {
    policyId: requiredString(row, "id"),
    salonId: requiredString(row, "salon_id"),
    version: safeInteger(row, "version"),
    name: requiredString(row, "policy_name"),
    timezone: requiredString(row, "business_timezone"),
    effectiveBusinessDate: requiredString(row, "effective_business_date"),
    fairnessBandCents: safeInteger(row, "fairness_band_cents"),
    opportunityCreditStrategy: "catalog_plus_permitted_addons_before_tax_and_tip",
    lateArrivalBaselineStrategy: "median_eligible_team_credit_at_check_in",
    approvedBreakStrategy: "freeze_queue_position",
    unapprovedDepartureStrategy: "move_to_queue_end",
    unjustifiedRefusalStrategy: "move_to_queue_end",
    customerRejectionStrategy: "no_penalty",
    policyChangesDefaultToNextBusinessDay: true,
  };
}

function addons(value: unknown): TurnIqTrustedHandoffAddon[] {
  if (!Array.isArray(value)) throw new TurnIqGatewayError("stale_state");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TurnIqGatewayError("stale_state");
    }
    const row = entry as Row;
    return {
      serviceId: requiredString(row, "service_id"),
      name: requiredString(row, "name"),
      priceCents: safeInteger(row, "price_cents", -1),
      durationMinutes: safeInteger(row, "duration_minutes", -1),
    };
  });
}

function stringIds(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const id = (entry as Row)[key];
    return typeof id === "string" ? [id] : [];
  });
}

function mapResult(value: unknown): TurnIqHandoffCommandActionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: "server_error" };
  }
  const row = value as Row;
  if (
    row.ok !== true ||
    typeof row.command_id !== "string" ||
    typeof row.handoff_plan_id !== "string" ||
    typeof row.booking_id !== "string" ||
    typeof row.status !== "string" ||
    !Number.isSafeInteger(row.state_version)
  ) {
    return { ok: false, code: row.ok === false ? "stale_state" : "server_error" };
  }
  return {
    ok: true,
    result: {
      commandId: row.command_id,
      replayed: row.replayed === true,
      handoffPlanId: row.handoff_plan_id,
      bookingId: row.booking_id,
      status: row.status,
      stateVersion: Number(row.state_version),
      performerIds: [
        ...(typeof row.performer_id === "string" ? [row.performer_id] : []),
        ...stringIds(row.performers, "performer_id"),
      ],
      fairnessReceiptIds: stringIds(row.fairness_receipts, "fairness_receipt_id"),
    },
  };
}

function mapFailure(error: unknown): TurnIqHandoffCommandActionResult {
  if (error instanceof TurnIqGatewayError) return { ok: false, code: error.code };
  if (error instanceof TurnIqContractError) return { ok: false, code: "stale_state" };
  return { ok: false, code: "server_error" };
}

async function replayCommand(input: {
  commandId: string;
  salonId: string;
  deviceId: string;
  localSequence: number;
  actorUserId: string;
  actorRole: string;
  commandType: "recommend_handoff" | "confirm_handoff" | "start" | "complete";
  requestFingerprint?: string;
}): Promise<TurnIqHandoffCommandActionResult | null> {
  const { data, error } = await createServiceRoleClient()
    .from("turniq_command_receipts" as never)
    .select("salon_id, device_id, local_sequence, actor_user_id, actor_role, command_type, request_fingerprint, result" as never)
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
    (input.requestFingerprint !== undefined && row.request_fingerprint !== input.requestFingerprint)
  ) {
    return { ok: false, code: "idempotency_conflict" };
  }
  return mapResult(row.result);
}

async function loadDecisionContext(input: {
  salonId: string;
  bookingId: string;
  capturedAt: string;
}) {
  const db = createServiceRoleClient();
  const [salonResult, bookingResult, segmentResult] = await Promise.all([
    db.from("salons").select("id, timezone").eq("id", input.salonId).maybeSingle(),
    db
      .from("bookings")
      .select("id, salon_id, status, schedule_model, start_time_utc, deleted_at")
      .eq("id", input.bookingId)
      .eq("salon_id", input.salonId)
      .maybeSingle(),
    db
      .from("booking_service_segments" as never)
      .select("id, booking_id, position, service_id, service_name, staff_id, resource_id, customer_start_utc, customer_end_utc, occupied_start_utc, occupied_end_utc, service_duration_minutes, sequential_addon_minutes, trailing_buffer_minutes, original_service_price_cents, addon_pre_voucher_cents, addon_lines, reservation_status" as never)
      .eq("salon_id" as never, input.salonId)
      .eq("booking_id" as never, input.bookingId)
      .in("reservation_status" as never, ["pending", "confirmed", "waiting"])
      .order("position" as never, { ascending: true }),
  ]);
  for (const result of [salonResult, bookingResult, segmentResult]) {
    if (result.error) throw databaseError(result.error);
  }
  if (!salonResult.data || !bookingResult.data) throw new TurnIqGatewayError("not_found");
  const salon = salonResult.data as unknown as Row;
  const bookingRow = bookingResult.data as unknown as Row;
  if (bookingRow.deleted_at !== null) throw new TurnIqGatewayError("not_found");
  const timezone = requiredString(salon, "timezone");
  const businessDate = salonYmdOfUtc(input.capturedAt, timezone);
  if (salonYmdOfUtc(requiredString(bookingRow, "start_time_utc"), timezone) !== businessDate) {
    throw new TurnIqGatewayError("stale_state");
  }
  const { startUtc, endUtc } = salonDayRangeUtc(businessDate, timezone);
  const policyResult = await db
    .from("turniq_policy_versions" as never)
    .select("id, salon_id, version, policy_name, business_timezone, effective_business_date, fairness_band_cents" as never)
    .eq("salon_id" as never, input.salonId)
    .lte("effective_business_date" as never, businessDate)
    .order("effective_business_date" as never, { ascending: false })
    .order("version" as never, { ascending: false })
    .limit(1)
    .maybeSingle();
  if (policyResult.error) throw databaseError(policyResult.error);
  if (!policyResult.data) throw new TurnIqGatewayError("stale_state");
  const policy = policyFromRow(policyResult.data as unknown as Row);
  if (policy.timezone !== timezone) throw new TurnIqGatewayError("stale_state");

  const segmentRows = (segmentResult.data ?? []) as unknown as Row[];
  if (segmentRows.length < 2 || segmentRows.length > 5) {
    throw new TurnIqGatewayError("not_found");
  }
  const parsedAddons = segmentRows.map((row) => addons(row.addon_lines));
  const serviceIds = [
    ...new Set(
      segmentRows.flatMap((row, index) => [
        requiredString(row, "service_id"),
        ...parsedAddons[index].map((addon) => addon.serviceId),
      ]),
    ),
  ];
  const resourceIds = [
    ...new Set(
      segmentRows.map((row) => nullableString(row, "resource_id")).filter((id): id is string => Boolean(id)),
    ),
  ];
  const [staffResult, shiftResult, capabilityResult, occupiedBookingResult, occupiedSegmentResult, resourceResult, policyPairResult] = await Promise.all([
    db.from("staff").select("id, name, status").eq("salon_id", input.salonId).is("deleted_at", null),
    db
      .from("turniq_shift_sessions" as never)
      .select("id, policy_version_id, staff_id, business_date, checked_in_at, state, queue_position, fairness_baseline_cents, service_credit_since_checkin_cents, state_version" as never)
      .eq("salon_id" as never, input.salonId)
      .eq("policy_version_id" as never, policy.policyId)
      .eq("business_date" as never, businessDate)
      .is("checked_out_at" as never, null),
    db.from("staff_services").select("staff_id, service_id").in("service_id", serviceIds),
    db
      .from("bookings")
      .select("id, staff_id, resource_id, start_time_utc, end_time_utc, status")
      .eq("salon_id", input.salonId)
      .is("deleted_at", null)
      .lt("start_time_utc", endUtc)
      .gt("end_time_utc", startUtc)
      .in("status", ["pending", "confirmed", "in_progress"]),
    db
      .from("booking_service_segments" as never)
      .select("id, booking_id, staff_id, resource_id, occupied_start_utc, occupied_end_utc, reservation_status" as never)
      .eq("salon_id" as never, input.salonId)
      .lt("occupied_start_utc" as never, endUtc)
      .gt("occupied_end_utc" as never, startUtc)
      .in("reservation_status" as never, ["pending", "confirmed", "in_progress"]),
    resourceIds.length > 0
      ? db.from("salon_resources").select("id, kind, status, same_guest_parallel_capacity").eq("salon_id", input.salonId).in("id", resourceIds).is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
    db.from("service_parallel_policies" as never).select("id, service_a_id, service_b_id, resource_mode, active" as never).eq("salon_id" as never, input.salonId),
  ]);
  for (const result of [staffResult, shiftResult, capabilityResult, occupiedBookingResult, occupiedSegmentResult, resourceResult, policyPairResult]) {
    if (result.error) throw databaseError(result.error);
  }
  const segments: TurnIqTrustedHandoffSegment[] = segmentRows.map((row, index) => ({
    id: requiredString(row, "id"),
    bookingId: requiredString(row, "booking_id"),
    position: safeInteger(row, "position"),
    serviceId: requiredString(row, "service_id"),
    serviceName: requiredString(row, "service_name"),
    staffId: requiredString(row, "staff_id"),
    resourceId: nullableString(row, "resource_id"),
    customerStartAt: requiredString(row, "customer_start_utc"),
    customerEndAt: requiredString(row, "customer_end_utc"),
    occupiedStartAt: requiredString(row, "occupied_start_utc"),
    occupiedEndAt: requiredString(row, "occupied_end_utc"),
    serviceDurationMinutes: safeInteger(row, "service_duration_minutes"),
    sequentialAddonMinutes: safeInteger(row, "sequential_addon_minutes"),
    trailingBufferMinutes: safeInteger(row, "trailing_buffer_minutes"),
    originalServicePriceCents: safeInteger(row, "original_service_price_cents"),
    addonPreVoucherCents: safeInteger(row, "addon_pre_voucher_cents"),
    addonLines: parsedAddons[index],
  }));
  const staff: TurnIqTrustedStaff[] = ((staffResult.data ?? []) as unknown as Row[]).map((row) => ({
    id: requiredString(row, "id"), name: requiredString(row, "name"), active: row.status === "active",
  }));
  const shifts: TurnIqTrustedShift[] = ((shiftResult.data ?? []) as unknown as Row[]).map((row) => ({
    id: requiredString(row, "id"),
    policyVersionId: requiredString(row, "policy_version_id"),
    staffId: requiredString(row, "staff_id"),
    businessDate: requiredString(row, "business_date"),
    checkedInAt: requiredString(row, "checked_in_at"),
    state: requiredString(row, "state") as TurnIqTrustedShift["state"],
    queuePosition: safeInteger(row, "queue_position"),
    fairnessBaselineCents: safeInteger(row, "fairness_baseline_cents"),
    serviceCreditSinceCheckInCents: safeInteger(row, "service_credit_since_checkin_cents"),
    stateVersion: safeInteger(row, "state_version"),
  }));
  const capabilities: TurnIqTrustedCapability[] = ((capabilityResult.data ?? []) as unknown as Row[]).map((row) => ({
    staffId: requiredString(row, "staff_id"), serviceId: requiredString(row, "service_id"),
  }));
  const occupiedBookings: (TurnIqTrustedOccupiedBooking & { bookingId: string | null })[] = [
    ...((occupiedBookingResult.data ?? []) as unknown as Row[]).map((row) => ({
      id: requiredString(row, "id"),
      bookingId: requiredString(row, "id"),
      staffId: nullableString(row, "staff_id"),
      resourceId: nullableString(row, "resource_id"),
      startAt: requiredString(row, "start_time_utc"),
      endAt: requiredString(row, "end_time_utc"),
      status: requiredString(row, "status"),
    })),
    ...((occupiedSegmentResult.data ?? []) as unknown as Row[]).map((row) => ({
      id: `segment:${requiredString(row, "id")}`,
      bookingId: requiredString(row, "booking_id"),
      staffId: nullableString(row, "staff_id"),
      resourceId: nullableString(row, "resource_id"),
      startAt: requiredString(row, "occupied_start_utc"),
      endAt: requiredString(row, "occupied_end_utc"),
      status: requiredString(row, "reservation_status"),
    })),
  ];
  const trusted = await buildTrustedTurnIqHandoffDecisionInput({
    salonId: input.salonId,
    capturedAt: input.capturedAt,
    businessDate,
    policy,
    booking: {
      id: requiredString(bookingRow, "id"),
      salonId: requiredString(bookingRow, "salon_id"),
      status: requiredString(bookingRow, "status") as "pending" | "confirmed" | "waiting",
      scheduleModel: requiredString(bookingRow, "schedule_model"),
    },
    segments,
    staff,
    shifts,
    capabilities,
    occupiedBookings,
    resources: ((resourceResult.data ?? []) as unknown as Row[]).map((row) => ({
      id: requiredString(row, "id"),
      kind: requiredString(row, "kind"),
      active: row.status === "active",
      sameGuestParallelCapacity: safeInteger(row, "same_guest_parallel_capacity", 1),
    })),
    parallelPolicies: ((policyPairResult.data ?? []) as unknown as Row[]).map((row) => ({
      id: requiredString(row, "id"),
      serviceAId: requiredString(row, "service_a_id"),
      serviceBId: requiredString(row, "service_b_id"),
      resourceMode: requiredString(row, "resource_mode") as "shared" | "distinct" | "either",
      active: row.active === true,
    })),
  });
  return { db, policy, segments, trusted };
}

export async function recommendTrustedTurnIqHandoff(
  input: TurnIqHandoffRecommendationActionInput,
  now: () => string = () => new Date().toISOString(),
): Promise<TurnIqHandoffCommandActionResult> {
  try {
    const context = await resolveTurnIqContext(input.slug);
    if (!context) return { ok: false, code: "unauthorized" };
    if (!context.featureEnabled) return { ok: false, code: "feature_disabled" };
    if (!turnIqStageAllowsOnlineMutation(context.rolloutStage)) return { ok: false, code: "rollout_stage_blocked" };
    if (!canUseTurnIqLiveBoard(context.role)) return { ok: false, code: "forbidden" };
    const replay = await replayCommand({
      ...input,
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      actorRole: context.actorRole,
      commandType: "recommend_handoff",
    });
    if (replay) return replay;
    const occurredAt = now();
    const { db, policy, segments, trusted } = await loadDecisionContext({
      salonId: context.salonId,
      bookingId: input.bookingId,
      capturedAt: occurredAt,
    });
    const decision = await decideTurnIqMultiTechnicianHandoff(trusted.decisionInput);
    if (decision.assignments.length !== segments.length || !decision.internalTrace.objectiveScore) {
      return { ok: false, code: "stale_state" };
    }
    const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
    for (const assignment of decision.assignments) {
      const segment = segmentById.get(assignment.segmentId);
      if (
        !segment ||
        segment.staffId !== assignment.staffId ||
        segment.resourceId !== assignment.resourceId ||
        new Date(segment.occupiedStartAt).toISOString() !== assignment.startsAt ||
        new Date(segment.occupiedEndAt).toISOString() !== assignment.releasesAt
      ) {
        // Scheduling owns the committed assignment. A later M4S reschedule
        // command may bridge a different recommendation; this adapter never
        // silently rewrites capacity rows.
        return { ok: false, code: "stale_state" };
      }
    }
    const requestFingerprint = await sha256TurnIqHex(canonicalTurnIqJson({
      kind: "turniq_handoff_recommendation_command_v1",
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      policyVersionId: policy.policyId,
      bookingId: input.bookingId,
      snapshotVersion: decision.snapshotVersion,
      commandId: input.commandId,
      deviceId: input.deviceId,
      localSequence: input.localSequence,
    }));
    const assignments = new Map(decision.assignments.map((assignment) => [assignment.segmentId, assignment]));
    const payload = segments.map((segment) => {
      const assignment = assignments.get(segment.id);
      if (!assignment) throw new TurnIqGatewayError("stale_state");
      const shiftSessionId = trusted.shiftSessionByStaffId.get(assignment.staffId);
      if (!shiftSessionId) throw new TurnIqGatewayError("stale_state");
      return {
        segmentId: segment.id,
        serviceId: segment.serviceId,
        recommendedStaffId: assignment.staffId,
        shiftSessionId,
        resourceId: assignment.resourceId,
        startsAt: assignment.startsAt,
        releasesAt: assignment.releasesAt,
        opportunityCreditCents: assignment.opportunityCreditCents,
        requestedStaffId: null,
        requestedTechSource: null,
        requestTrustLabel: null,
        requestedTechActorRef: null,
        requestedTechRecordedAt: null,
        requestedFallback: false,
      };
    });
    const { data, error } = await db.rpc("record_turniq_handoff_plan_v1" as never, {
      p_salon_id: context.salonId,
      p_policy_version_id: policy.policyId,
      p_booking_id: input.bookingId,
      p_customer_request_id: input.bookingId,
      p_decision_timestamp: decision.decidedAt,
      p_decision_fingerprint: decision.fingerprint,
      p_snapshot_version: decision.snapshotVersion,
      p_privacy_safe_explanation: decision.privacySafeExplanation,
      p_objective_score: decision.internalTrace.objectiveScore,
      p_candidate_trace: decision.internalTrace.candidateTraces,
      p_segments: payload,
      p_command_id: input.commandId,
      p_device_id: input.deviceId,
      p_local_sequence: input.localSequence,
      p_actor_user_id: context.actorUserId,
      p_actor_role: context.actorRole,
      p_request_fingerprint: requestFingerprint,
      p_occurred_at: occurredAt,
    } as never);
    if (error) throw databaseError(error);
    return mapResult(data);
  } catch (error) {
    return mapFailure(error);
  }
}

export async function confirmTrustedTurnIqHandoff(
  input: TurnIqHandoffConfirmationActionInput,
  now: () => string = () => new Date().toISOString(),
): Promise<TurnIqHandoffCommandActionResult> {
  try {
    const context = await resolveTurnIqContext(input.slug);
    if (!context) return { ok: false, code: "unauthorized" };
    if (!context.featureEnabled) return { ok: false, code: "feature_disabled" };
    if (!turnIqStageAllowsOnlineMutation(context.rolloutStage)) return { ok: false, code: "rollout_stage_blocked" };
    if (!canUseTurnIqLiveBoard(context.role)) return { ok: false, code: "forbidden" };
    const db = createServiceRoleClient();
    const { data: planData, error: planError } = await db
      .from("turniq_handoff_plans" as never)
      .select("id, policy_version_id, status, state_version" as never)
      .eq("salon_id" as never, context.salonId)
      .eq("id" as never, input.handoffPlanId)
      .maybeSingle();
    if (planError) throw databaseError(planError);
    if (!planData) return { ok: false, code: "not_found" };
    const plan = planData as unknown as Row;
    if (plan.status !== "recommended" || safeInteger(plan, "state_version") !== input.expectedStateVersion) {
      return { ok: false, code: "stale_state" };
    }
    const { data: performerData, error: performerError } = await db
      .from("turniq_handoff_performers" as never)
      .select("requested_fallback" as never)
      .eq("salon_id" as never, context.salonId)
      .eq("handoff_plan_id" as never, input.handoffPlanId);
    if (performerError) throw databaseError(performerError);
    const hasFallback = ((performerData ?? []) as unknown as Row[]).some((row) => row.requested_fallback === true);
    if (hasFallback && !input.overrideReason) return { ok: false, code: "owner_confirmation_required" };
    const occurredAt = now();
    const policyVersionId = requiredString(plan, "policy_version_id");
    const requestFingerprint = await sha256TurnIqHex(canonicalTurnIqJson({
      kind: "turniq_handoff_confirmation_command_v1",
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      policyVersionId,
      handoffPlanId: input.handoffPlanId,
      expectedStateVersion: input.expectedStateVersion,
      overrideReason: input.overrideReason ?? null,
      commandId: input.commandId,
      deviceId: input.deviceId,
      localSequence: input.localSequence,
    }));
    const replay = await replayCommand({
      ...input,
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      actorRole: context.actorRole,
      commandType: "confirm_handoff",
      requestFingerprint,
    });
    if (replay) return replay;
    const { data, error } = await db.rpc("confirm_turniq_handoff_plan_v1" as never, {
      p_salon_id: context.salonId,
      p_policy_version_id: policyVersionId,
      p_handoff_plan_id: input.handoffPlanId,
      p_override_reason: input.overrideReason ?? null,
      p_command_id: input.commandId,
      p_device_id: input.deviceId,
      p_local_sequence: input.localSequence,
      p_actor_user_id: context.actorUserId,
      p_actor_role: context.actorRole,
      p_request_fingerprint: requestFingerprint,
      p_occurred_at: occurredAt,
    } as never);
    if (error) throw databaseError(error);
    return mapResult(data);
  } catch (error) {
    return mapFailure(error);
  }
}

export async function applyTrustedTurnIqHandoffPerformerCommand(
  input: TurnIqHandoffPerformerActionInput,
  now: () => string = () => new Date().toISOString(),
): Promise<TurnIqHandoffCommandActionResult> {
  try {
    const context = await resolveTurnIqContext(input.slug);
    if (!context) return { ok: false, code: "unauthorized" };
    if (!context.featureEnabled) return { ok: false, code: "feature_disabled" };
    if (!turnIqStageAllowsOnlineMutation(context.rolloutStage)) return { ok: false, code: "rollout_stage_blocked" };
    if (!canUseTurnIqLiveBoard(context.role)) return { ok: false, code: "forbidden" };
    const db = createServiceRoleClient();
    const { data: planData, error: planError } = await db
      .from("turniq_handoff_plans" as never)
      .select("id, policy_version_id" as never)
      .eq("salon_id" as never, context.salonId)
      .eq("id" as never, input.handoffPlanId)
      .maybeSingle();
    if (planError) throw databaseError(planError);
    if (!planData) return { ok: false, code: "not_found" };
    const policyVersionId = requiredString(planData as unknown as Row, "policy_version_id");
    const occurredAt = now();
    const requestFingerprint = await sha256TurnIqHex(canonicalTurnIqJson({
      kind: "turniq_handoff_performer_command_v1",
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      policyVersionId,
      handoffPlanId: input.handoffPlanId,
      performerId: input.performerId,
      command: input.command,
      commandId: input.commandId,
      deviceId: input.deviceId,
      localSequence: input.localSequence,
    }));
    const replay = await replayCommand({
      ...input,
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      actorRole: context.actorRole,
      commandType: input.command,
      requestFingerprint,
    });
    if (replay) return replay;
    const { data, error } = await db.rpc("apply_turniq_handoff_performer_command_v1" as never, {
      p_salon_id: context.salonId,
      p_policy_version_id: policyVersionId,
      p_handoff_plan_id: input.handoffPlanId,
      p_performer_id: input.performerId,
      p_command_type: input.command,
      p_command_id: input.commandId,
      p_device_id: input.deviceId,
      p_local_sequence: input.localSequence,
      p_actor_user_id: context.actorUserId,
      p_actor_role: context.actorRole,
      p_request_fingerprint: requestFingerprint,
      p_occurred_at: occurredAt,
    } as never);
    if (error) throw databaseError(error);
    return mapResult(data);
  } catch (error) {
    return mapFailure(error);
  }
}

export async function loadTrustedTurnIqHandoffPlan(
  slug: string,
  handoffPlanId: string,
): Promise<HandoffPlanReadResult> {
  try {
    const context = await resolveTurnIqContext(slug);
    if (!context) return { ok: false, code: "unauthorized" };
    if (!context.featureEnabled) return { ok: false, code: "feature_disabled" };
    if (!canUseTurnIqLiveBoard(context.role)) return { ok: false, code: "forbidden" };
    const db = createServiceRoleClient();
    const [planResult, performerResult, itemResult] = await Promise.all([
      db.from("turniq_handoff_plans" as never).select("id, booking_id, status, state_version, privacy_safe_explanation" as never).eq("salon_id" as never, context.salonId).eq("id" as never, handoffPlanId).maybeSingle(),
      db.from("turniq_handoff_performers" as never).select("id, assignment_id, proposed_staff_id, segment_count, requested_fallback" as never).eq("salon_id" as never, context.salonId).eq("handoff_plan_id" as never, handoffPlanId).order("performer_position" as never, { ascending: true }),
      db.from("turniq_handoff_plan_items" as never).select("performer_id, booking_segment_id, resource_id, starts_at, releases_at, requested_fallback" as never).eq("salon_id" as never, context.salonId).eq("handoff_plan_id" as never, handoffPlanId).order("item_position" as never, { ascending: true }),
    ]);
    for (const result of [planResult, performerResult, itemResult]) if (result.error) throw databaseError(result.error);
    if (!planResult.data) return { ok: false, code: "not_found" };
    const performers = (performerResult.data ?? []) as unknown as Row[];
    const items = (itemResult.data ?? []) as unknown as Row[];
    if (performers.length === 0 || items.length === 0) return { ok: false, code: "stale_state" };
    const assignmentIds = performers.map((row) => requiredString(row, "assignment_id"));
    const segmentIds = items.map((row) => requiredString(row, "booking_segment_id"));
    const staffIds = [...new Set(performers.map((row) => requiredString(row, "proposed_staff_id")))];
    const resourceIds = [...new Set(items.map((row) => nullableString(row, "resource_id")).filter((id): id is string => Boolean(id)))];
    const [assignmentResult, receiptResult, segmentResult, staffResult, resourceResult] = await Promise.all([
      db.from("turniq_assignments" as never).select("id, status" as never).eq("salon_id" as never, context.salonId).in("id" as never, assignmentIds),
      db.from("turniq_fairness_receipts" as never).select("id, assignment_id" as never).eq("salon_id" as never, context.salonId).in("assignment_id" as never, assignmentIds),
      db.from("booking_service_segments" as never).select("id, service_name" as never).eq("salon_id" as never, context.salonId).in("id" as never, segmentIds),
      db.from("staff").select("id, name").eq("salon_id", context.salonId).in("id", staffIds),
      resourceIds.length > 0 ? db.from("salon_resources").select("id, name").eq("salon_id", context.salonId).in("id", resourceIds) : Promise.resolve({ data: [], error: null }),
    ]);
    for (const result of [assignmentResult, receiptResult, segmentResult, staffResult, resourceResult]) if (result.error) throw databaseError(result.error);
    const assignmentStatus = new Map(((assignmentResult.data ?? []) as unknown as Row[]).map((row) => [requiredString(row, "id"), requiredString(row, "status")]));
    const receipts = new Map(((receiptResult.data ?? []) as unknown as Row[]).map((row) => [requiredString(row, "assignment_id"), requiredString(row, "id")]));
    const segmentNames = new Map(((segmentResult.data ?? []) as unknown as Row[]).map((row) => [requiredString(row, "id"), requiredString(row, "service_name")]));
    const plan = planResult.data as unknown as Row;
    return {
      ok: true,
      data: projectTurnIqHandoffPlan({
        plan: {
          id: requiredString(plan, "id"),
          bookingId: requiredString(plan, "booking_id"),
          status: requiredString(plan, "status"),
          stateVersion: safeInteger(plan, "state_version"),
          explanation: requiredString(plan, "privacy_safe_explanation"),
        },
        performers: performers.map((row) => {
          const assignmentId = requiredString(row, "assignment_id");
          return {
            id: requiredString(row, "id"),
            assignmentId,
            staffId: requiredString(row, "proposed_staff_id"),
            status: assignmentStatus.get(assignmentId) ?? "unknown",
            segmentCount: safeInteger(row, "segment_count"),
            requestedFallback: row.requested_fallback === true,
            fairnessReceiptId: receipts.get(assignmentId) ?? null,
          };
        }),
        items: items.map((row) => ({
          performerId: requiredString(row, "performer_id"),
          segmentId: requiredString(row, "booking_segment_id"),
          serviceName: segmentNames.get(requiredString(row, "booking_segment_id")) ?? "Booked service",
          resourceId: nullableString(row, "resource_id"),
          startsAt: requiredString(row, "starts_at"),
          releasesAt: requiredString(row, "releases_at"),
          requestedFallback: row.requested_fallback === true,
        })),
        staff: ((staffResult.data ?? []) as unknown as Row[]).map((row) => ({ id: requiredString(row, "id"), name: requiredString(row, "name") })),
        resources: ((resourceResult.data ?? []) as unknown as Row[]).map((row) => ({ id: requiredString(row, "id"), name: requiredString(row, "name") })),
      }),
    };
  } catch (error) {
    if (error instanceof TurnIqGatewayError) return { ok: false, code: error.code };
    return { ok: false, code: "server_error" };
  }
}

export async function loadTrustedTurnIqHandoffQueue(
  slug: string,
  now: () => string = () => new Date().toISOString(),
): Promise<HandoffQueueReadResult> {
  try {
    const context = await resolveTurnIqContext(slug);
    if (!context) return { ok: false, code: "unauthorized" };
    if (!context.featureEnabled) return { ok: false, code: "feature_disabled" };
    if (!canUseTurnIqLiveBoard(context.role)) return { ok: false, code: "forbidden" };
    const db = createServiceRoleClient();
    const { data: salonData, error: salonError } = await db.from("salons").select("id, timezone").eq("id", context.salonId).maybeSingle();
    if (salonError) throw databaseError(salonError);
    if (!salonData) return { ok: false, code: "not_found" };
    const timezone = requiredString(salonData as unknown as Row, "timezone");
    const businessDate = salonYmdOfUtc(now(), timezone);
    const { startUtc, endUtc } = salonDayRangeUtc(businessDate, timezone);
    const { data: bookingData, error: bookingError } = await db.from("bookings").select("id, start_time_utc, status, schedule_model").eq("salon_id", context.salonId).eq("schedule_model", "segments_v1").is("deleted_at", null).gte("start_time_utc", startUtc).lt("start_time_utc", endUtc).in("status", ["pending", "confirmed", "waiting"]);
    if (bookingError) throw databaseError(bookingError);
    const bookings = (bookingData ?? []) as unknown as Row[];
    if (bookings.length === 0) return { ok: true, data: { businessDate, bookings: [] } };
    const bookingIds = bookings.map((row) => requiredString(row, "id"));
    const [segmentResult, planResult] = await Promise.all([
      db.from("booking_service_segments" as never).select("booking_id, staff_id, service_name, occupied_start_utc, reservation_status" as never).eq("salon_id" as never, context.salonId).in("booking_id" as never, bookingIds).in("reservation_status" as never, ["pending", "confirmed", "waiting"]).order("position" as never, { ascending: true }),
      db.from("turniq_handoff_plans" as never).select("id, booking_id, status" as never).eq("salon_id" as never, context.salonId).in("booking_id" as never, bookingIds).in("status" as never, ["recommended", "confirming", "confirmed", "in_progress"]),
    ]);
    if (segmentResult.error) throw databaseError(segmentResult.error);
    if (planResult.error) throw databaseError(planResult.error);
    const grouped = new Map<string, Row[]>();
    for (const row of (segmentResult.data ?? []) as unknown as Row[]) {
      const bookingId = requiredString(row, "booking_id");
      grouped.set(bookingId, [...(grouped.get(bookingId) ?? []), row]);
    }
    const plans = new Map(((planResult.data ?? []) as unknown as Row[]).map((row) => [requiredString(row, "booking_id"), row]));
    const queue = bookings.flatMap((booking) => {
      const bookingId = requiredString(booking, "id");
      const segments = grouped.get(bookingId) ?? [];
      if (segments.length < 2 || segments.length > 5) return [];
      const plan = plans.get(bookingId);
      if (plan?.status === "confirmed") return [];
      return [{
        bookingId,
        segmentCount: segments.length,
        serviceSummary: segments.map((row) => requiredString(row, "service_name")).join(" → "),
        startsAt: requiredString(booking, "start_time_utc"),
        existingPlanId: plan ? requiredString(plan, "id") : null,
        existingPlanStatus: plan ? requiredString(plan, "status") : null,
        readiness: "ready" as const,
      }];
    });
    return { ok: true, data: { businessDate, bookings: queue } };
  } catch (error) {
    if (error instanceof TurnIqGatewayError) return { ok: false, code: error.code };
    return { ok: false, code: "server_error" };
  }
}
