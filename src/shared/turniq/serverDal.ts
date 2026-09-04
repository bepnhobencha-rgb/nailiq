import "server-only";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isReleaseFeatureVisible } from "@/shared/features/platformFeatureFlags";
import type { SalonMemberRole } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { salonDayRangeUtc, salonYmdOfUtc } from "@/shared/lib/salonTime";
import {
  canSeeTurnIqOwnerFinancialTruth,
  canUseTurnIqExceptionInbox,
  canUseTurnIqLiveBoard,
  canUseTurnIqStaffView,
} from "@/shared/turniq/access";
import {
  TurnIqGatewayError,
  type TurnIqActionGateway,
  type TurnIqAuthorizedContext,
  type TurnIqRpcOutcome,
} from "@/shared/turniq/actionCore";
import {
  projectTurnIqExceptionInbox,
  projectTurnIqFairnessReceipt,
  projectTurnIqLiveBoard,
  projectTurnIqStaffView,
  type TurnIqAssignmentReadRow,
  type TurnIqCandidateReadRow,
  type TurnIqCorrectionReadRow,
  type TurnIqDisputeReadRow,
  type TurnIqExceptionInboxView,
  type TurnIqExceptionReadRow,
  type TurnIqFairnessReceiptReadRow,
  type TurnIqFairnessReceiptView,
  type TurnIqLiveBoardView,
  type TurnIqPilotEvidenceView,
  type TurnIqServiceDirectoryEntry,
  type TurnIqShiftReadRow,
  type TurnIqStaffDirectoryEntry,
  type TurnIqStaffView,
  type TurnIqSwapReadRow,
} from "@/shared/turniq/readModels";
import type {
  TurnIqDecisionInput,
  TurnIqReasonCode,
  TurnIqRequestTrustLabel,
  TurnIqRequestedTechSource,
} from "@/shared/turniq/contracts";
import { requestedTechTrustLabel } from "@/shared/turniq/contracts";
import { canonicalTurnIqJson, sha256TurnIqHex } from "@/shared/turniq/fingerprint";
import { decideSingleCustomer } from "@/shared/turniq/singleCustomerEngine";
import type { TurnIqTrustedConfirmationSnapshot } from "@/shared/turniq/trustedSnapshot";
import type { TurnIqServerActionErrorCode } from "@/shared/turniq/serverContracts";
import type { TurnIqStaffPinGateway } from "@/shared/turniq/staffPin";
import {
  parseTurnIqRolloutStage,
  turnIqStageAllowsRead,
  type TurnIqRolloutStage,
} from "@/shared/turniq/rolloutStage";

type TurnIqReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: TurnIqServerActionErrorCode };

type AuthorizedReadContext = TurnIqAuthorizedContext & {
  role: SalonMemberRole;
};

type DatabaseError = { code?: string; message?: string } | null;

function rowId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

function pilotInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function pilotNullableInteger(row: Record<string, unknown>, key: string): number | null {
  return row[key] === null ? null : pilotInteger(row, key);
}

function mapPilotEvidence(value: unknown): TurnIqPilotEvidenceView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.business_date !== "string" ||
    row.targets_are_hypotheses !== true ||
    row.walkaway_rate_is_proxy !== true ||
    row.offline_loss_evidence_complete !== false
  ) return null;
  const rawSources = row.request_source_counts;
  const requestSourceCounts = rawSources && typeof rawSources === "object" && !Array.isArray(rawSources)
    ? Object.fromEntries(Object.entries(rawSources as Record<string, unknown>)
        .flatMap(([key, count]) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? [[key, count]] : []))
    : {};
  const opportunityDistribution = Array.isArray(row.opportunity_distribution)
    ? row.opportunity_distribution.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const item = entry as Record<string, unknown>;
        if (typeof item.staff_id !== "string") return [];
        return [{
          staffId: item.staff_id,
          opportunityCreditCents: pilotInteger(item, "opportunity_credit_cents"),
          turns: pilotInteger(item, "turns"),
        }];
      })
    : [];
  return {
    businessDate: row.business_date,
    targetsAreHypotheses: true,
    recommendations: pilotInteger(row, "recommendations"),
    completedCustomers: pilotInteger(row, "completed_customers"),
    confirmedAssignments: pilotInteger(row, "confirmed_assignments"),
    recommendationAcceptanceBasisPoints: pilotNullableInteger(row, "recommendation_acceptance_basis_points"),
    overrides: pilotInteger(row, "overrides"),
    medianAssignmentSeconds: pilotNullableInteger(row, "median_assignment_seconds"),
    waitP50Minutes: pilotNullableInteger(row, "wait_p50_minutes"),
    waitP90Minutes: pilotNullableInteger(row, "wait_p90_minutes"),
    walkinsJoined: pilotInteger(row, "walkins_joined"),
    walkaways: pilotInteger(row, "walkaways"),
    walkawayRateBasisPoints: pilotNullableInteger(row, "walkaway_rate_basis_points"),
    walkawayRateIsProxy: true,
    fairnessReceipts: pilotInteger(row, "fairness_receipts"),
    normalTurnsWithoutOwnerBasisPoints: pilotNullableInteger(row, "normal_turns_without_owner_basis_points"),
    exceptions: pilotInteger(row, "exceptions"),
    unresolvedExceptions: pilotInteger(row, "unresolved_exceptions"),
    disputes: pilotInteger(row, "disputes"),
    unresolvedDisputes: pilotInteger(row, "unresolved_disputes"),
    unresolvedOfflineConflicts: pilotInteger(row, "unresolved_offline_conflicts"),
    duplicateCommandConflicts: pilotInteger(row, "duplicate_command_conflicts"),
    ownerDecisionSecondsObserved: pilotInteger(row, "owner_decision_seconds_observed"),
    offlineLossEvidenceComplete: false,
    requestSourceCounts,
    opportunityDistribution,
    opportunitySpreadCents: pilotInteger(row, "opportunity_spread_cents"),
  };
}

function gatewayErrorFromDatabase(error: DatabaseError): TurnIqGatewayError {
  if (error?.code === "23505") return new TurnIqGatewayError("idempotency_conflict");
  if (error?.code === "42501") return new TurnIqGatewayError("forbidden");
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

export async function resolveTurnIqContext(
  slug: string,
): Promise<AuthorizedReadContext | null> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || ctx.kind !== "member" || !ctx.userId) return null;
  const admin = createServiceRoleClient();
  const [featureVisible, staffResult, rolloutStage] = await Promise.all([
    isReleaseFeatureVisible(ctx.salon, "turniq_trust_engine"),
    admin
      .from("staff")
      .select("id")
      .eq("salon_id", ctx.salon.id)
      .eq("user_id", ctx.userId)
      .eq("status", "active")
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle(),
    loadTurnIqRolloutStage(ctx.salon.id, admin),
  ]);
  if (staffResult.error) throw gatewayErrorFromDatabase(staffResult.error);
  const featureEnabled = featureVisible && turnIqStageAllowsRead(rolloutStage);
  return {
    salonId: ctx.salon.id,
    actorUserId: ctx.userId,
    actorRole: ctx.role,
    actorStaffId: staffResult.data?.id ? String(staffResult.data.id) : null,
    featureEnabled,
    rolloutStage,
    role: ctx.role,
  };
}

export async function loadTurnIqRolloutStage(
  salonId: string,
  client = createServiceRoleClient(),
): Promise<TurnIqRolloutStage> {
  const { data, error } = await client
    .from("turniq_rollout_controls" as never)
    .select("stage" as never)
    .eq("salon_id" as never, salonId)
    .maybeSingle();
  if (error || !data) return "off";
  return parseTurnIqRolloutStage(
    (data as unknown as { stage?: unknown }).stage,
  );
}

export const turnIqActionGateway: TurnIqActionGateway = {
  resolveContext: resolveTurnIqContext,
  async loadAssignment(salonId, assignmentId) {
    const { data, error } = await createServiceRoleClient()
      .from("turniq_assignments" as never)
      .select("assigned_staff_id" as never)
      .eq("salon_id" as never, salonId)
      .eq("id" as never, assignmentId)
      .maybeSingle();
    if (error) throw gatewayErrorFromDatabase(error);
    if (!data) return null;
    const row = data as unknown as { assigned_staff_id?: unknown };
    return {
      assignedStaffId:
        typeof row.assigned_staff_id === "string" ? row.assigned_staff_id : null,
    };
  },
  async applyShift(args) {
    const { data, error } = await createServiceRoleClient().rpc(
      "apply_turniq_shift_command_v1" as never,
      {
        p_salon_id: args.salonId,
        p_policy_version_id: args.policyVersionId,
        p_staff_id: args.staffId,
        p_command_type: args.commandType,
        p_reason: args.reason,
        p_command_id: args.commandId,
        p_device_id: args.deviceId,
        p_local_sequence: args.localSequence,
        p_actor_user_id: args.actorUserId,
        p_actor_role: args.actorRole,
        p_request_fingerprint: args.requestFingerprint,
        p_occurred_at: args.occurredAt,
      } as never,
    );
    if (error) throw gatewayErrorFromDatabase(error);
    return data as unknown as TurnIqRpcOutcome;
  },
  async applyAssignment(args) {
    const client = createServiceRoleClient();
    const { data, error } = args.commandType === "complete"
      ? await client.rpc(
          "complete_turniq_assignment_command_v2" as never,
          {
            p_salon_id: args.salonId,
            p_policy_version_id: args.policyVersionId,
            p_assignment_id: args.assignmentId,
            p_command_id: args.commandId,
            p_device_id: args.deviceId,
            p_local_sequence: args.localSequence,
            p_actor_user_id: args.actorUserId,
            p_actor_role: args.actorRole,
            p_request_fingerprint: args.requestFingerprint,
            p_occurred_at: args.occurredAt,
          } as never,
        )
      : await client.rpc(
          "apply_turniq_assignment_command_v1" as never,
          {
            p_salon_id: args.salonId,
            p_policy_version_id: args.policyVersionId,
            p_assignment_id: args.assignmentId,
            p_command_type: args.commandType,
            p_assigned_staff_id: args.assignedStaffId,
            p_override_reason: args.overrideReason,
            p_command_id: args.commandId,
            p_device_id: args.deviceId,
            p_local_sequence: args.localSequence,
            p_actor_user_id: args.actorUserId,
            p_actor_role: args.actorRole,
            p_request_fingerprint: args.requestFingerprint,
            p_occurred_at: args.occurredAt,
          } as never,
        );
    if (error) throw gatewayErrorFromDatabase(error);
    return data as unknown as TurnIqRpcOutcome;
  },
  async applyRefusal(args) {
    const { data, error } = await createServiceRoleClient().rpc(
      "apply_turniq_refusal_command_v1" as never,
      {
        p_salon_id: args.salonId,
        p_policy_version_id: args.policyVersionId,
        p_assignment_id: args.assignmentId,
        p_refusal_category: args.category,
        p_reason: args.reason,
        p_command_id: args.commandId,
        p_device_id: args.deviceId,
        p_local_sequence: args.localSequence,
        p_actor_user_id: args.actorUserId,
        p_actor_role: args.actorRole,
        p_request_fingerprint: args.requestFingerprint,
        p_occurred_at: args.occurredAt,
      } as never,
    );
    if (error) throw gatewayErrorFromDatabase(error);
    return data as unknown as TurnIqRpcOutcome;
  },
  async applyRedo(args) {
    const { data, error } = await createServiceRoleClient().rpc(
      "apply_turniq_redo_classification_v1" as never,
      {
        p_salon_id: args.salonId,
        p_policy_version_id: args.policyVersionId,
        p_assignment_id: args.assignmentId,
        p_original_assignment_id: args.originalAssignmentId,
        p_redo_category: args.category,
        p_note: args.note,
        p_command_id: args.commandId,
        p_device_id: args.deviceId,
        p_local_sequence: args.localSequence,
        p_actor_user_id: args.actorUserId,
        p_actor_role: args.actorRole,
        p_request_fingerprint: args.requestFingerprint,
        p_occurred_at: args.occurredAt,
      } as never,
    );
    if (error) throw gatewayErrorFromDatabase(error);
    return data as unknown as TurnIqRpcOutcome;
  },
  async applySwap(args) {
    const { data, error } = await createServiceRoleClient().rpc(
      "apply_turniq_swap_command_v1" as never,
      {
        p_salon_id: args.salonId,
        p_policy_version_id: args.policyVersionId,
        p_assignment_id: args.assignmentId,
        p_swap_id: args.swapId,
        p_command_type: args.commandType,
        p_to_staff_id: args.toStaffId,
        p_consent_decision: args.consentDecision,
        p_reason: args.reason,
        p_command_id: args.commandId,
        p_device_id: args.deviceId,
        p_local_sequence: args.localSequence,
        p_actor_user_id: args.actorUserId,
        p_actor_role: args.actorRole,
        p_request_fingerprint: args.requestFingerprint,
        p_occurred_at: args.occurredAt,
      } as never,
    );
    if (error) throw gatewayErrorFromDatabase(error);
    return data as unknown as TurnIqRpcOutcome;
  },
  async applyCorrection(args) {
    const { data, error } = await createServiceRoleClient().rpc(
      "apply_turniq_assignment_correction_v1" as never,
      {
        p_salon_id: args.salonId,
        p_policy_version_id: args.policyVersionId,
        p_assignment_id: args.assignmentId,
        p_actual_staff_id: args.actualStaffId,
        p_category: args.category,
        p_reason: args.reason,
        p_command_id: args.commandId,
        p_device_id: args.deviceId,
        p_local_sequence: args.localSequence,
        p_actor_user_id: args.actorUserId,
        p_actor_role: args.actorRole,
        p_request_fingerprint: args.requestFingerprint,
        p_occurred_at: args.occurredAt,
      } as never,
    );
    if (error) throw gatewayErrorFromDatabase(error);
    return data as unknown as TurnIqRpcOutcome;
  },
  async createDispute(args) {
    const { data, error } = await createServiceRoleClient().rpc(
      "create_turniq_dispute_v1" as never,
      {
        p_salon_id: args.salonId,
        p_policy_version_id: args.policyVersionId,
        p_fairness_receipt_id: args.fairnessReceiptId,
        p_category: args.category,
        p_reason: args.reason,
        p_command_id: args.commandId,
        p_device_id: args.deviceId,
        p_local_sequence: args.localSequence,
        p_actor_user_id: args.actorUserId,
        p_actor_role: args.actorRole,
        p_request_fingerprint: args.requestFingerprint,
        p_occurred_at: args.occurredAt,
      } as never,
    );
    if (error) throw gatewayErrorFromDatabase(error);
    return data as unknown as TurnIqRpcOutcome;
  },
  async createSkipDispute(args) {
    const { data, error } = await createServiceRoleClient().rpc(
      "create_turniq_skip_dispute_v1" as never,
      {
        p_salon_id: args.salonId,
        p_policy_version_id: args.policyVersionId,
        p_assignment_id: args.assignmentId,
        p_category: args.category,
        p_reason: args.reason,
        p_command_id: args.commandId,
        p_device_id: args.deviceId,
        p_local_sequence: args.localSequence,
        p_actor_user_id: args.actorUserId,
        p_actor_role: args.actorRole,
        p_request_fingerprint: args.requestFingerprint,
        p_occurred_at: args.occurredAt,
      } as never,
    );
    if (error) throw gatewayErrorFromDatabase(error);
    return data as unknown as TurnIqRpcOutcome;
  },
  async resolveDispute(args) {
    const { data, error } = await createServiceRoleClient().rpc(
      "resolve_turniq_dispute_v1" as never,
      {
        p_salon_id: args.salonId,
        p_policy_version_id: args.policyVersionId,
        p_dispute_id: args.disputeId,
        p_resolution_status: args.resolutionStatus,
        p_reason: args.reason,
        p_command_id: args.commandId,
        p_device_id: args.deviceId,
        p_local_sequence: args.localSequence,
        p_actor_user_id: args.actorUserId,
        p_actor_role: args.actorRole,
        p_request_fingerprint: args.requestFingerprint,
        p_occurred_at: args.occurredAt,
      } as never,
    );
    if (error) throw gatewayErrorFromDatabase(error);
    return data as unknown as TurnIqRpcOutcome;
  },
  async applyException(args) {
    const { data, error } = await createServiceRoleClient().rpc(
      "apply_turniq_exception_command_v1" as never,
      {
        p_salon_id: args.salonId,
        p_policy_version_id: args.policyVersionId,
        p_exception_id: args.exceptionId,
        p_command_type: args.commandType,
        p_reason: args.reason,
        p_command_id: args.commandId,
        p_device_id: args.deviceId,
        p_local_sequence: args.localSequence,
        p_actor_user_id: args.actorUserId,
        p_actor_role: args.actorRole,
        p_request_fingerprint: args.requestFingerprint,
        p_occurred_at: args.occurredAt,
      } as never,
    );
    if (error) throw gatewayErrorFromDatabase(error);
    return data as unknown as TurnIqRpcOutcome;
  },
};

export const turnIqStaffPinGateway: TurnIqStaffPinGateway = {
  resolveContext: resolveTurnIqContext,
  async configurePin(args) {
    const { data, error } = await createServiceRoleClient().rpc(
      "configure_turniq_staff_pin_v1" as never,
      {
        p_salon_id: args.salonId,
        p_staff_id: args.staffId,
        p_pin: args.pin,
        p_command_id: args.commandId,
        p_actor_user_id: args.actorUserId,
        p_actor_role: args.actorRole,
        p_occurred_at: args.occurredAt,
      } as never,
    );
    if (error) throw gatewayErrorFromDatabase(error);
    return data as never;
  },
  async applyPinShift(args) {
    const { data, error } = await createServiceRoleClient().rpc(
      "apply_turniq_staff_pin_shift_command_v1" as never,
      {
        p_salon_id: args.salonId,
        p_policy_version_id: args.policyVersionId,
        p_staff_id: args.staffId,
        p_pin: args.pin,
        p_command_type: args.commandType,
        p_reason: args.reason,
        p_command_id: args.commandId,
        p_device_id: args.deviceId,
        p_local_sequence: args.localSequence,
        p_actor_user_id: args.actorUserId,
        p_actor_role: args.actorRole,
        p_request_fingerprint: args.requestFingerprint,
        p_occurred_at: args.occurredAt,
      } as never,
    );
    if (error) throw gatewayErrorFromDatabase(error);
    return data as unknown as TurnIqRpcOutcome;
  },
};

/**
 * Persists a recommendation produced from a server-owned snapshot. This is a
 * DAL primitive, deliberately not a Server Action: browser input must never be
 * able to supply the recommended technician or internal decision trace.
 */
export async function recordTrustedTurnIqRecommendation(input: {
  slug: string;
  decisionInput: TurnIqDecisionInput;
  resourceId: string | null;
  confirmationSnapshot: TurnIqTrustedConfirmationSnapshot;
  commandId: string;
  deviceId: string;
  localSequence: number;
}): Promise<TurnIqRpcOutcome> {
  const context = await resolveTurnIqContext(input.slug);
  if (!context) throw new TurnIqGatewayError("unauthorized");
  if (!context.featureEnabled) throw new TurnIqGatewayError("feature_disabled");
  if (!canUseTurnIqLiveBoard(context.role)) {
    throw new TurnIqGatewayError("forbidden");
  }
  const decision = await decideSingleCustomer(input.decisionInput);
  const request = input.decisionInput.request;
  if (
    request.salonId !== context.salonId ||
    decision.salonId !== context.salonId ||
    decision.policyId !== input.decisionInput.policy.policyId ||
    decision.policyVersion !== input.decisionInput.policy.version ||
    decision.recommendedStaffId === null ||
    request.bookingId === null
  ) {
    throw new TurnIqGatewayError("stale_state");
  }
  const requestFingerprint = await sha256TurnIqHex(
    canonicalTurnIqJson({
      kind: "turniq_recommendation_command_v1",
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      policyVersionId: decision.policyId,
      bookingId: request.bookingId,
      customerRequestId: request.requestId,
      commandId: input.commandId,
      deviceId: input.deviceId,
      localSequence: input.localSequence,
    }),
  );
  const requested = request.requestedTechnician;
  const eligible = decision.candidates.filter((candidate) => candidate.eligible);
  const skipped = decision.candidates.filter((candidate) => !candidate.eligible);
  const { data, error } = await createServiceRoleClient().rpc(
    "record_turniq_recommendation_v1" as never,
    {
      p_salon_id: context.salonId,
      p_policy_version_id: decision.policyId,
      p_booking_id: request.bookingId,
      p_customer_request_id: request.requestId,
      p_recommended_staff_id: decision.recommendedStaffId,
      p_resource_id: input.resourceId,
      p_requested_staff_id: requested?.staffId ?? null,
      p_requested_tech_source: requested?.source ?? null,
      p_request_trust_label: requested
        ? requestedTechTrustLabel(requested.source)
        : null,
      p_requested_tech_actor_ref: requested?.actorId ?? null,
      p_requested_tech_recorded_at: requested?.recordedAt ?? null,
      p_decision_timestamp: decision.decidedAt,
      p_decision_fingerprint: decision.fingerprint,
      p_snapshot_version: decision.snapshotVersion,
      p_privacy_safe_explanation: decision.privacySafeExplanation,
      p_eligible_candidates: eligible,
      p_skipped_candidates: skipped,
      p_internal_decision_trace: {
        ...decision.internalTrace,
        trustedConfirmationSnapshot: input.confirmationSnapshot,
      },
      p_command_id: input.commandId,
      p_device_id: input.deviceId,
      p_local_sequence: input.localSequence,
      p_actor_user_id: context.actorUserId,
      p_actor_role: context.actorRole,
      p_request_fingerprint: requestFingerprint,
      p_occurred_at: new Date().toISOString(),
    } as never,
  );
  if (error) throw gatewayErrorFromDatabase(error);
  return data as unknown as TurnIqRpcOutcome;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrZero(value: unknown): number {
  return Number.isSafeInteger(value) ? Number(value) : 0;
}

function reasonCodes(value: unknown): readonly TurnIqReasonCode[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is TurnIqReasonCode => typeof entry === "string");
}

function candidateRows(value: unknown): readonly TurnIqCandidateReadRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const staffId = stringOrNull(row.staffId ?? row.staff_id);
    if (!staffId) return [];
    const queue = row.queuePosition ?? row.queue_position;
    const rank = row.rank;
    return [{
      staffId,
      reasonCodes: reasonCodes(row.reasonCodes ?? row.reason_codes),
      queuePosition: Number.isSafeInteger(queue) ? Number(queue) : 0,
      rank: Number.isSafeInteger(rank) ? Number(rank) : null,
    }];
  });
}

function mapShift(row: Record<string, unknown>): TurnIqShiftReadRow {
  return {
    id: String(row.id),
    staffId: String(row.staff_id),
    businessDate: String(row.business_date),
    state: String(row.state) as TurnIqShiftReadRow["state"],
    queuePosition: numberOrZero(row.queue_position),
    turnsConsumed: numberOrZero(row.turns_consumed),
    fairnessBaselineCents: numberOrZero(row.fairness_baseline_cents),
    serviceCreditSinceCheckInCents: numberOrZero(
      row.service_credit_since_checkin_cents,
    ),
  };
}

function mapAssignment(row: Record<string, unknown>): TurnIqAssignmentReadRow {
  return {
    id: String(row.id),
    policyVersionId: String(row.policy_version_id),
    bookingId: stringOrNull(row.booking_id),
    serviceId: stringOrNull(row.service_id),
    resourceId: stringOrNull(row.resource_id),
    recommendedStaffId: stringOrNull(row.recommended_staff_id),
    assignedStaffId: stringOrNull(row.assigned_staff_id),
    requestedStaffId: stringOrNull(row.requested_staff_id),
    requestedTechSource: stringOrNull(row.requested_tech_source) as TurnIqRequestedTechSource | null,
    requestTrustLabel: stringOrNull(row.request_trust_label) as TurnIqRequestTrustLabel | null,
    decisionTimestamp: String(row.decision_timestamp),
    privacySafeExplanation: String(row.privacy_safe_explanation),
    eligibleCandidates: candidateRows(row.eligible_candidates),
    skippedCandidates: candidateRows(row.skipped_candidates),
    refusalCategory: stringOrNull(row.refusal_category) as TurnIqAssignmentReadRow["refusalCategory"],
    refusalReason: stringOrNull(row.refusal_reason),
    refusalOutcome: stringOrNull(row.refusal_outcome) as TurnIqAssignmentReadRow["refusalOutcome"],
    refusedAt: stringOrNull(row.refused_at),
    redoOriginalAssignmentId: stringOrNull(row.redo_original_assignment_id),
    redoCategory: stringOrNull(row.redo_category) as TurnIqAssignmentReadRow["redoCategory"],
    redoNote: stringOrNull(row.redo_note),
    redoConsumesTurn:
      typeof row.redo_consumes_turn === "boolean" ? row.redo_consumes_turn : null,
    redoCreditsOpportunity:
      typeof row.redo_credits_opportunity === "boolean"
        ? row.redo_credits_opportunity
        : null,
    redoClassifiedAt: stringOrNull(row.redo_classified_at),
    completedAt: stringOrNull(row.completed_at),
    status: String(row.status) as TurnIqAssignmentReadRow["status"],
  };
}

function mapReceipt(row: Record<string, unknown>): TurnIqFairnessReceiptReadRow {
  return {
    id: String(row.id),
    policyVersionId: String(row.policy_version_id),
    assignmentId: String(row.assignment_id),
    recommendedStaffId: stringOrNull(row.recommended_staff_id),
    assignedStaffId: String(row.assigned_staff_id),
    serviceId: stringOrNull(row.service_id),
    resourceId: stringOrNull(row.resource_id),
    requestedTechSource: stringOrNull(row.requested_tech_source) as TurnIqRequestedTechSource | null,
    requestTrustLabel: stringOrNull(row.request_trust_label) as TurnIqRequestTrustLabel | null,
    privacySafeExplanation: String(row.privacy_safe_explanation),
    skippedReasonCodes: reasonCodes(row.skipped_reason_codes),
    fairnessBandCents: numberOrZero(row.fairness_band_cents),
    decisionFingerprint: String(row.decision_fingerprint),
    commandFingerprint: String(row.command_fingerprint),
    actorRole: String(row.actor_role),
    assignmentOutcome: String(row.assignment_outcome) as TurnIqFairnessReceiptReadRow["assignmentOutcome"],
    overrideReason: stringOrNull(row.override_reason),
    createdAt: String(row.created_at),
  };
}

function mapException(row: Record<string, unknown>): TurnIqExceptionReadRow {
  const detail = row.detail && typeof row.detail === "object"
    ? row.detail as Record<string, unknown>
    : {};
  return {
    id: String(row.id),
    policyVersionId: String(row.policy_version_id),
    assignmentId: stringOrNull(row.assignment_id),
    disputeId: stringOrNull(detail.dispute_id),
    exceptionType: String(row.exception_type),
    status: String(row.status) as TurnIqExceptionReadRow["status"],
    privacySafeSummary: String(row.privacy_safe_summary),
    recommendedAction: String(row.recommended_action),
    stateVersion: numberOrZero(row.state_version),
    createdAt: String(row.created_at),
  };
}

function mapDispute(row: Record<string, unknown>): TurnIqDisputeReadRow {
  return {
    id: String(row.id),
    policyVersionId: String(row.policy_version_id),
    assignmentId: String(row.assignment_id),
    fairnessReceiptId: stringOrNull(row.fairness_receipt_id),
    targetType: String(row.target_type) as TurnIqDisputeReadRow["targetType"],
    raisedByStaffId: String(row.raised_by_staff_id),
    category: String(row.category) as TurnIqDisputeReadRow["category"],
    privacySafeReason: String(row.privacy_safe_reason),
    status: String(row.status) as TurnIqDisputeReadRow["status"],
    resolutionReason: stringOrNull(row.resolution_reason),
    stateVersion: numberOrZero(row.state_version),
    createdAt: String(row.created_at),
  };
}

function mapSwap(
  row: Record<string, unknown>,
  consentRows: readonly Record<string, unknown>[],
): TurnIqSwapReadRow {
  const id = String(row.id);
  return {
    id,
    policyVersionId: String(row.policy_version_id),
    assignmentId: String(row.assignment_id),
    fromStaffId: String(row.from_staff_id),
    toStaffId: String(row.to_staff_id),
    reason: String(row.reason),
    status: String(row.status) as TurnIqSwapReadRow["status"],
    consentedStaffIds: consentRows.flatMap((consent) =>
      consent.swap_id === id && consent.decision === "accepted"
        ? [String(consent.staff_id)]
        : [],
    ),
    requestedAt: String(row.requested_at),
    appliedAt: stringOrNull(row.applied_at),
  };
}

function mapCorrection(row: Record<string, unknown>): TurnIqCorrectionReadRow {
  return {
    id: String(row.id),
    policyVersionId: String(row.policy_version_id),
    assignmentId: String(row.assignment_id),
    fairnessReceiptId: String(row.fairness_receipt_id),
    sequence: numberOrZero(row.correction_sequence),
    category: String(row.category) as TurnIqCorrectionReadRow["category"],
    reason: String(row.reason),
    previousStaffId: String(row.previous_staff_id),
    actualStaffId: String(row.actual_staff_id),
    turnMoved: row.turn_moved === true,
    opportunityCreditMovedCents: numberOrZero(
      row.opportunity_credit_moved_cents,
    ),
    correctedAt: String(row.corrected_at),
  };
}

async function directory(
  salonId: string,
): Promise<{
  staff: TurnIqStaffDirectoryEntry[];
  services: TurnIqServiceDirectoryEntry[];
}> {
  const db = createServiceRoleClient();
  const [staffResult, serviceResult] = await Promise.all([
    db.from("staff")
      .select("id, name")
      .eq("salon_id", salonId)
      .eq("status", "active")
      .is("deleted_at", null),
    db.from("services").select("id, name").eq("salon_id", salonId).is("deleted_at", null),
  ]);
  if (staffResult.error) throw gatewayErrorFromDatabase(staffResult.error);
  if (serviceResult.error) throw gatewayErrorFromDatabase(serviceResult.error);
  return {
    staff: (staffResult.data ?? []).map((row) => ({ id: String(row.id), name: String(row.name) })),
    services: (serviceResult.data ?? []).map((row) => ({ id: String(row.id), name: String(row.name) })),
  };
}

async function authorizedRead(
  slug: string,
): Promise<AuthorizedReadContext | TurnIqReadResult<never>> {
  try {
    const context = await resolveTurnIqContext(slug);
    if (!context) return { ok: false, code: "unauthorized" };
    if (!context.featureEnabled) return { ok: false, code: "feature_disabled" };
    return context;
  } catch (error) {
    return {
      ok: false,
      code: error instanceof TurnIqGatewayError ? error.code : "server_error",
    };
  }
}

function isReadFailure(
  value: AuthorizedReadContext | TurnIqReadResult<never>,
): value is TurnIqReadResult<never> {
  return "ok" in value;
}

export async function loadTurnIqLiveBoard(
  slug: string,
): Promise<TurnIqReadResult<TurnIqLiveBoardView>> {
  const context = await authorizedRead(slug);
  if (isReadFailure(context)) return context;
  if (!canUseTurnIqLiveBoard(context.role)) return { ok: false, code: "forbidden" };
  try {
    const db = createServiceRoleClient();
    const { data: salonData, error: salonError } = await db
      .from("salons")
      .select("timezone")
      .eq("id", context.salonId)
      .maybeSingle();
    if (salonError) throw gatewayErrorFromDatabase(salonError);
    const timezone = salonData?.timezone?.trim();
    if (!timezone) throw new TurnIqGatewayError("stale_state");
    const businessDate = salonYmdOfUtc(new Date().toISOString(), timezone);
    const { startUtc, endUtc } = salonDayRangeUtc(businessDate, timezone);
    const redoHistoryStartUtc = new Date(
      Date.parse(startUtc) - 31 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const [
      policyResult,
      shiftResult,
      assignmentResult,
      redoCandidateResult,
      exceptionResult,
      swapResult,
      swapConsentResult,
      correctionResult,
      names,
    ] = await Promise.all([
      db.from("turniq_policy_versions" as never)
        .select("id" as never)
        .eq("salon_id" as never, context.salonId)
        .lte("effective_business_date" as never, businessDate)
        .order("effective_business_date" as never, { ascending: false })
        .order("version" as never, { ascending: false })
        .limit(1)
        .maybeSingle(),
      db.from("turniq_shift_sessions" as never)
        .select("id, staff_id, business_date, state, queue_position, turns_consumed, fairness_baseline_cents, service_credit_since_checkin_cents" as never)
        .eq("salon_id" as never, context.salonId)
        .eq("business_date" as never, businessDate)
        .is("checked_out_at" as never, null)
        .order("queue_position" as never, { ascending: true }),
      db.from("turniq_assignments" as never)
        .select("id, policy_version_id, booking_id, service_id, resource_id, recommended_staff_id, assigned_staff_id, requested_staff_id, requested_tech_source, request_trust_label, decision_timestamp, privacy_safe_explanation, eligible_candidates, skipped_candidates, refusal_category, refusal_reason, refusal_outcome, refused_at, redo_original_assignment_id, redo_category, redo_note, redo_consumes_turn, redo_credits_opportunity, redo_classified_at, completed_at, status" as never)
        .eq("salon_id" as never, context.salonId)
        .in("status" as never, ["recommended", "confirmed", "in_progress"])
        .gte("decision_timestamp" as never, startUtc)
        .lt("decision_timestamp" as never, endUtc)
        .order("decision_timestamp" as never, { ascending: true }),
      db.from("turniq_assignments" as never)
        .select("id, policy_version_id, booking_id, service_id, resource_id, recommended_staff_id, assigned_staff_id, requested_staff_id, requested_tech_source, request_trust_label, decision_timestamp, privacy_safe_explanation, eligible_candidates, skipped_candidates, refusal_category, refusal_reason, refusal_outcome, refused_at, redo_original_assignment_id, redo_category, redo_note, redo_consumes_turn, redo_credits_opportunity, redo_classified_at, completed_at, status" as never)
        .eq("salon_id" as never, context.salonId)
        .eq("status" as never, "completed")
        .gte("completed_at" as never, redoHistoryStartUtc)
        .order("completed_at" as never, { ascending: false })
        .limit(50),
      db.from("turniq_exceptions" as never)
        .select("id, assignment_id" as never)
        .eq("salon_id" as never, context.salonId)
        .in("status" as never, ["open", "acknowledged"]),
      db.from("turniq_assignment_swaps" as never)
        .select("id, policy_version_id, assignment_id, from_staff_id, to_staff_id, reason, status, requested_at, applied_at" as never)
        .eq("salon_id" as never, context.salonId)
        .in("status" as never, ["pending_consents", "ready"])
        .order("requested_at" as never, { ascending: true }),
      db.from("turniq_swap_consents" as never)
        .select("swap_id, staff_id, decision" as never)
        .eq("salon_id" as never, context.salonId),
      db.from("turniq_assignment_corrections" as never)
        .select("id, policy_version_id, assignment_id, fairness_receipt_id, correction_sequence, category, reason, previous_staff_id, actual_staff_id, turn_moved, opportunity_credit_moved_cents, corrected_at" as never)
        .eq("salon_id" as never, context.salonId)
        .order("corrected_at" as never, { ascending: false })
        .limit(20),
      directory(context.salonId),
    ]);
    if (policyResult.error) throw gatewayErrorFromDatabase(policyResult.error);
    if (shiftResult.error) throw gatewayErrorFromDatabase(shiftResult.error);
    if (assignmentResult.error) throw gatewayErrorFromDatabase(assignmentResult.error);
    if (redoCandidateResult.error) {
      throw gatewayErrorFromDatabase(redoCandidateResult.error);
    }
    if (exceptionResult.error) throw gatewayErrorFromDatabase(exceptionResult.error);
    if (swapResult.error) throw gatewayErrorFromDatabase(swapResult.error);
    if (swapConsentResult.error) {
      throw gatewayErrorFromDatabase(swapConsentResult.error);
    }
    if (correctionResult.error) {
      throw gatewayErrorFromDatabase(correctionResult.error);
    }
    const consentRows = (swapConsentResult.data ?? []) as unknown as Record<
      string,
      unknown
    >[];
    const pilotResult = canSeeTurnIqOwnerFinancialTruth(context.role)
      ? await db.rpc("get_turniq_pilot_evidence_v1" as never, {
          p_salon_id: context.salonId,
          p_business_date: businessDate,
          p_actor_user_id: context.actorUserId,
          p_actor_role: context.actorRole,
        } as never)
      : { data: null, error: null };
    if (pilotResult.error) throw gatewayErrorFromDatabase(pilotResult.error);
    const projected = projectTurnIqLiveBoard({
      businessDate,
      activePolicyVersionId: rowId(policyResult.data),
      shifts: ((shiftResult.data ?? []) as unknown as Record<string, unknown>[]).map(mapShift),
      assignments: ((assignmentResult.data ?? []) as unknown as Record<string, unknown>[]).map(mapAssignment),
      redoCandidates: ((redoCandidateResult.data ?? []) as unknown as Record<string, unknown>[]).map(mapAssignment),
      staff: names.staff,
      services: names.services,
      openExceptionCount: exceptionResult.data?.length ?? 0,
      blockedAssignmentIds: ((exceptionResult.data ?? []) as unknown as Record<string, unknown>[])
        .flatMap((row) =>
          typeof row.assignment_id === "string" ? [row.assignment_id] : [],
        ),
      swaps: ((swapResult.data ?? []) as unknown as Record<string, unknown>[])
        .map((row) => mapSwap(row, consentRows)),
      corrections: ((correctionResult.data ?? []) as unknown as Record<
        string,
        unknown
      >[]).map(mapCorrection),
    });
    return {
      ok: true,
      data: { ...projected, pilotEvidence: mapPilotEvidence(pilotResult.data) },
    };
  } catch (error) {
    return { ok: false, code: error instanceof TurnIqGatewayError ? error.code : "server_error" };
  }
}

export async function loadTurnIqStaffView(
  slug: string,
): Promise<TurnIqReadResult<TurnIqStaffView | null>> {
  const context = await authorizedRead(slug);
  if (isReadFailure(context)) return context;
  if (!canUseTurnIqStaffView(context.role)) return { ok: false, code: "forbidden" };
  if (!context.actorStaffId) return { ok: true, data: null };
  try {
    const db = createServiceRoleClient();
    const { data: salonData, error: salonError } = await db
      .from("salons")
      .select("timezone")
      .eq("id", context.salonId)
      .maybeSingle();
    if (salonError) throw gatewayErrorFromDatabase(salonError);
    const timezone = salonData?.timezone?.trim();
    if (!timezone) throw new TurnIqGatewayError("stale_state");
    const businessDate = salonYmdOfUtc(new Date().toISOString(), timezone);
    const { startUtc, endUtc } = salonDayRangeUtc(businessDate, timezone);
    const [
      policyResult,
      shiftResult,
      recommendedAssignmentResult,
      assignedAssignmentResult,
      dayAssignmentResult,
      receiptResult,
      disputeResult,
      swapFromResult,
      swapToResult,
      swapConsentResult,
      correctionFromResult,
      correctionToResult,
      names,
    ] = await Promise.all([
      db.from("turniq_policy_versions" as never)
        .select("id" as never)
        .eq("salon_id" as never, context.salonId)
        .lte("effective_business_date" as never, businessDate)
        .order("effective_business_date" as never, { ascending: false })
        .order("version" as never, { ascending: false })
        .limit(1)
        .maybeSingle(),
      db.from("turniq_shift_sessions" as never)
        .select("id, staff_id, business_date, state, queue_position, turns_consumed, fairness_baseline_cents, service_credit_since_checkin_cents" as never)
        .eq("salon_id" as never, context.salonId)
        .eq("staff_id" as never, context.actorStaffId)
        .is("checked_out_at" as never, null)
        .maybeSingle(),
      db.from("turniq_assignments" as never)
        .select("id, policy_version_id, booking_id, service_id, resource_id, recommended_staff_id, assigned_staff_id, requested_staff_id, requested_tech_source, request_trust_label, decision_timestamp, privacy_safe_explanation, eligible_candidates, skipped_candidates, refusal_category, refusal_reason, refusal_outcome, refused_at, redo_original_assignment_id, redo_category, redo_note, redo_consumes_turn, redo_credits_opportunity, redo_classified_at, completed_at, status" as never)
        .eq("salon_id" as never, context.salonId)
        .in("status" as never, ["recommended", "confirmed", "in_progress"])
        .eq("recommended_staff_id" as never, context.actorStaffId),
      db.from("turniq_assignments" as never)
        .select("id, policy_version_id, booking_id, service_id, resource_id, recommended_staff_id, assigned_staff_id, requested_staff_id, requested_tech_source, request_trust_label, decision_timestamp, privacy_safe_explanation, eligible_candidates, skipped_candidates, refusal_category, refusal_reason, refusal_outcome, refused_at, redo_original_assignment_id, redo_category, redo_note, redo_consumes_turn, redo_credits_opportunity, redo_classified_at, completed_at, status" as never)
        .eq("salon_id" as never, context.salonId)
        .in("status" as never, ["recommended", "confirmed", "in_progress"])
        .eq("assigned_staff_id" as never, context.actorStaffId),
      db.from("turniq_assignments" as never)
        .select("id, policy_version_id, booking_id, service_id, resource_id, recommended_staff_id, assigned_staff_id, requested_staff_id, requested_tech_source, request_trust_label, decision_timestamp, privacy_safe_explanation, eligible_candidates, skipped_candidates, refusal_category, refusal_reason, refusal_outcome, refused_at, redo_original_assignment_id, redo_category, redo_note, redo_consumes_turn, redo_credits_opportunity, redo_classified_at, completed_at, status" as never)
        .eq("salon_id" as never, context.salonId)
        .gte("decision_timestamp" as never, startUtc)
        .lt("decision_timestamp" as never, endUtc)
        .order("decision_timestamp" as never, { ascending: false }),
      db.from("turniq_fairness_receipts" as never)
        .select("id, policy_version_id, assignment_id, recommended_staff_id, assigned_staff_id, service_id, resource_id, requested_tech_source, request_trust_label, privacy_safe_explanation, skipped_reason_codes, fairness_band_cents, decision_fingerprint, command_fingerprint, actor_role, assignment_outcome, override_reason, created_at" as never)
        .eq("salon_id" as never, context.salonId)
        .eq("assigned_staff_id" as never, context.actorStaffId)
        .order("created_at" as never, { ascending: false })
        .limit(20),
      db.from("turniq_disputes" as never)
        .select("id, policy_version_id, assignment_id, fairness_receipt_id, target_type, raised_by_staff_id, category, privacy_safe_reason, status, resolution_reason, state_version, created_at" as never)
        .eq("salon_id" as never, context.salonId)
        .eq("raised_by_staff_id" as never, context.actorStaffId)
        .order("created_at" as never, { ascending: false })
        .limit(20),
      db.from("turniq_assignment_swaps" as never)
        .select("id, policy_version_id, assignment_id, from_staff_id, to_staff_id, reason, status, requested_at, applied_at" as never)
        .eq("salon_id" as never, context.salonId)
        .eq("from_staff_id" as never, context.actorStaffId)
        .order("requested_at" as never, { ascending: false })
        .limit(20),
      db.from("turniq_assignment_swaps" as never)
        .select("id, policy_version_id, assignment_id, from_staff_id, to_staff_id, reason, status, requested_at, applied_at" as never)
        .eq("salon_id" as never, context.salonId)
        .eq("to_staff_id" as never, context.actorStaffId)
        .order("requested_at" as never, { ascending: false })
        .limit(20),
      db.from("turniq_swap_consents" as never)
        .select("swap_id, staff_id, decision" as never)
        .eq("salon_id" as never, context.salonId),
      db.from("turniq_assignment_corrections" as never)
        .select("id, policy_version_id, assignment_id, fairness_receipt_id, correction_sequence, category, reason, previous_staff_id, actual_staff_id, turn_moved, opportunity_credit_moved_cents, corrected_at" as never)
        .eq("salon_id" as never, context.salonId)
        .eq("previous_staff_id" as never, context.actorStaffId)
        .order("corrected_at" as never, { ascending: false })
        .limit(20),
      db.from("turniq_assignment_corrections" as never)
        .select("id, policy_version_id, assignment_id, fairness_receipt_id, correction_sequence, category, reason, previous_staff_id, actual_staff_id, turn_moved, opportunity_credit_moved_cents, corrected_at" as never)
        .eq("salon_id" as never, context.salonId)
        .eq("actual_staff_id" as never, context.actorStaffId)
        .order("corrected_at" as never, { ascending: false })
        .limit(20),
      directory(context.salonId),
    ]);
    if (policyResult.error) throw gatewayErrorFromDatabase(policyResult.error);
    if (shiftResult.error) throw gatewayErrorFromDatabase(shiftResult.error);
    if (recommendedAssignmentResult.error) {
      throw gatewayErrorFromDatabase(recommendedAssignmentResult.error);
    }
    if (assignedAssignmentResult.error) {
      throw gatewayErrorFromDatabase(assignedAssignmentResult.error);
    }
    if (dayAssignmentResult.error) {
      throw gatewayErrorFromDatabase(dayAssignmentResult.error);
    }
    if (receiptResult.error) throw gatewayErrorFromDatabase(receiptResult.error);
    if (disputeResult.error) throw gatewayErrorFromDatabase(disputeResult.error);
    if (swapFromResult.error) {
      throw gatewayErrorFromDatabase(swapFromResult.error);
    }
    if (swapToResult.error) throw gatewayErrorFromDatabase(swapToResult.error);
    if (swapConsentResult.error) {
      throw gatewayErrorFromDatabase(swapConsentResult.error);
    }
    if (correctionFromResult.error) {
      throw gatewayErrorFromDatabase(correctionFromResult.error);
    }
    if (correctionToResult.error) {
      throw gatewayErrorFromDatabase(correctionToResult.error);
    }
    const swapRows = [
      ...new Map(
        [
          ...((swapFromResult.data ?? []) as unknown as Record<string, unknown>[]),
          ...((swapToResult.data ?? []) as unknown as Record<string, unknown>[]),
        ].map((row) => [String(row.id), row]),
      ).values(),
    ]
      .sort((left, right) =>
        String(right.requested_at).localeCompare(String(left.requested_at)),
      )
      .slice(0, 20);
    const correctionRows = [
      ...new Map(
        [
          ...((correctionFromResult.data ?? []) as unknown as Record<string, unknown>[]),
          ...((correctionToResult.data ?? []) as unknown as Record<string, unknown>[]),
        ].map((row) => [String(row.id), row]),
      ).values(),
    ]
      .sort((left, right) =>
        String(right.corrected_at).localeCompare(String(left.corrected_at)),
      )
      .slice(0, 20);
    const ownStaff = names.staff.find((entry) => entry.id === context.actorStaffId);
    if (!ownStaff) return { ok: true, data: null };
    return {
      ok: true,
      data: projectTurnIqStaffView({
        activePolicyVersionId: rowId(policyResult.data),
        staff: ownStaff,
        shift: shiftResult.data ? mapShift(shiftResult.data as unknown as Record<string, unknown>) : null,
        assignments: [
          ...new Map(
            [
              ...((recommendedAssignmentResult.data ?? []) as unknown as Record<string, unknown>[]),
              ...((assignedAssignmentResult.data ?? []) as unknown as Record<string, unknown>[]),
              ...((dayAssignmentResult.data ?? []) as unknown as Record<string, unknown>[])
                .filter(
                  (row) =>
                    row.recommended_staff_id === context.actorStaffId ||
                    candidateRows(row.skipped_candidates).some(
                      (candidate) => candidate.staffId === context.actorStaffId,
                    ),
                ),
            ].map((row) => [String(row.id), row]),
          ).values(),
        ].map(mapAssignment),
        receipts: ((receiptResult.data ?? []) as unknown as Record<string, unknown>[]).map(mapReceipt),
        disputes: ((disputeResult.data ?? []) as unknown as Record<string, unknown>[]).map(mapDispute),
        services: names.services,
        staffDirectory: names.staff,
        swaps: swapRows.map((row) =>
          mapSwap(
            row,
            (swapConsentResult.data ?? []) as unknown as Record<
              string,
              unknown
            >[],
          ),
        ),
        corrections: correctionRows.map(mapCorrection),
      }),
    };
  } catch (error) {
    return { ok: false, code: error instanceof TurnIqGatewayError ? error.code : "server_error" };
  }
}

export async function loadTurnIqFairnessReceipt(
  slug: string,
  receiptId: string,
): Promise<TurnIqReadResult<TurnIqFairnessReceiptView>> {
  const context = await authorizedRead(slug);
  if (isReadFailure(context)) return context;
  try {
    const db = createServiceRoleClient();
    const { data, error } = await db
      .from("turniq_fairness_receipts" as never)
      .select("id, policy_version_id, assignment_id, recommended_staff_id, assigned_staff_id, service_id, resource_id, requested_tech_source, request_trust_label, privacy_safe_explanation, skipped_reason_codes, fairness_band_cents, decision_fingerprint, command_fingerprint, actor_role, assignment_outcome, override_reason, created_at" as never)
      .eq("salon_id" as never, context.salonId)
      .eq("id" as never, receiptId)
      .maybeSingle();
    if (error) throw gatewayErrorFromDatabase(error);
    if (!data) return { ok: false, code: "not_found" };
    const receipt = mapReceipt(data as unknown as Record<string, unknown>);
    const { data: correctionData, error: correctionError } = await db
      .from("turniq_assignment_corrections" as never)
      .select("id, policy_version_id, assignment_id, fairness_receipt_id, correction_sequence, category, reason, previous_staff_id, actual_staff_id, turn_moved, opportunity_credit_moved_cents, corrected_at" as never)
      .eq("salon_id" as never, context.salonId)
      .eq("fairness_receipt_id" as never, receipt.id)
      .order("correction_sequence" as never, { ascending: true });
    if (correctionError) throw gatewayErrorFromDatabase(correctionError);
    const corrections = ((correctionData ?? []) as unknown as Record<
      string,
      unknown
    >[]).map(mapCorrection);
    const manager = canSeeTurnIqOwnerFinancialTruth(context.role);
    const frontDesk = canUseTurnIqLiveBoard(context.role);
    const affectedByCorrection = corrections.some(
      (correction) =>
        correction.previousStaffId === context.actorStaffId ||
        correction.actualStaffId === context.actorStaffId,
    );
    if (
      !manager && !frontDesk && receipt.assignedStaffId !== context.actorStaffId &&
      !affectedByCorrection
    ) {
      return { ok: false, code: "forbidden" };
    }
    const [names, financialResult] = await Promise.all([
      directory(context.salonId),
      manager
        ? db
            .from("turniq_assignments" as never)
            .select("opportunity_credit_cents, actual_service_revenue_cents, actual_tax_cents, actual_tip_cents" as never)
            .eq("salon_id" as never, context.salonId)
            .eq("id" as never, receipt.assignmentId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (financialResult.error) throw gatewayErrorFromDatabase(financialResult.error);
    const financial = financialResult.data as unknown as Record<string, unknown> | null;
    return {
      ok: true,
      data: projectTurnIqFairnessReceipt({
        receipt,
        staff: names.staff,
        services: names.services,
        includeOwnerDetail: manager,
        ownerFinancialTruth: manager
          ? {
              opportunityCreditCents: numberOrZero(financial?.opportunity_credit_cents),
              actualServiceRevenueCents: Number.isSafeInteger(financial?.actual_service_revenue_cents)
                ? Number(financial?.actual_service_revenue_cents)
                : null,
              actualTaxCents: Number.isSafeInteger(financial?.actual_tax_cents)
                ? Number(financial?.actual_tax_cents)
                : null,
              actualTipCents: Number.isSafeInteger(financial?.actual_tip_cents)
                ? Number(financial?.actual_tip_cents)
                : null,
            }
          : undefined,
        corrections,
      }),
    };
  } catch (error) {
    return { ok: false, code: error instanceof TurnIqGatewayError ? error.code : "server_error" };
  }
}

export async function loadTurnIqExceptionInbox(
  slug: string,
): Promise<TurnIqReadResult<TurnIqExceptionInboxView>> {
  const context = await authorizedRead(slug);
  if (isReadFailure(context)) return context;
  if (!canUseTurnIqExceptionInbox(context.role)) return { ok: false, code: "forbidden" };
  try {
    const db = createServiceRoleClient();
    const [exceptionResult, disputeResult] = await Promise.all([
      db.from("turniq_exceptions" as never)
        .select("id, policy_version_id, assignment_id, exception_type, status, privacy_safe_summary, recommended_action, detail, state_version, created_at" as never)
        .eq("salon_id" as never, context.salonId)
        .in("status" as never, ["open", "acknowledged"])
        .order("created_at" as never, { ascending: true }),
      db.from("turniq_disputes" as never)
        .select("id, policy_version_id, assignment_id, fairness_receipt_id, target_type, raised_by_staff_id, category, privacy_safe_reason, status, resolution_reason, state_version, created_at" as never)
        .eq("salon_id" as never, context.salonId)
        .in("status" as never, ["open", "under_review"])
        .order("created_at" as never, { ascending: true }),
    ]);
    if (exceptionResult.error) throw gatewayErrorFromDatabase(exceptionResult.error);
    if (disputeResult.error) throw gatewayErrorFromDatabase(disputeResult.error);
    return {
      ok: true,
      data: projectTurnIqExceptionInbox(
        ((exceptionResult.data ?? []) as unknown as Record<string, unknown>[]).map(mapException),
        ((disputeResult.data ?? []) as unknown as Record<string, unknown>[]).map(mapDispute),
      ),
    };
  } catch (error) {
    return { ok: false, code: error instanceof TurnIqGatewayError ? error.code : "server_error" };
  }
}
