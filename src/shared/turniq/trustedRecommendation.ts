import "server-only";

import { salonDayRangeUtc, salonYmdOfUtc } from "@/shared/lib/salonTime";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { canUseTurnIqLiveBoard } from "@/shared/turniq/access";
import { TurnIqGatewayError, type TurnIqRpcOutcome } from "@/shared/turniq/actionCore";
import type { TurnIqPolicyVersion } from "@/shared/turniq/contracts";
import {
  recordTrustedTurnIqRecommendation,
  resolveTurnIqContext,
} from "@/shared/turniq/serverDal";
import type {
  TurnIqRecommendationActionInput,
  TurnIqRecommendationActionResult,
} from "@/shared/turniq/serverContracts";
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
type DatabaseError = { code?: string; message?: string } | null;

function databaseError(error: DatabaseError): TurnIqGatewayError {
  if (error?.code === "42501") return new TurnIqGatewayError("forbidden");
  if (error?.code === "23505") {
    return new TurnIqGatewayError("idempotency_conflict");
  }
  if (error?.code === "40001" || error?.code === "55000") {
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

function resultFromRpc(outcome: TurnIqRpcOutcome): TurnIqRecommendationActionResult {
  if (
    !outcome.ok ||
    !outcome.command_id ||
    !outcome.assignment_id ||
    !outcome.status ||
    !Number.isSafeInteger(outcome.state_version)
  ) {
    return { ok: false, code: outcome.ok ? "server_error" : "stale_state" };
  }
  return {
    ok: true,
    result: {
      commandId: outcome.command_id,
      replayed: outcome.replayed === true,
      assignmentId: outcome.assignment_id,
      status: outcome.status,
      stateVersion: outcome.state_version as number,
    },
  };
}

function mapFailure(error: unknown): TurnIqRecommendationActionResult {
  if (error instanceof TurnIqGatewayError) {
    return { ok: false, code: error.code };
  }
  if (error instanceof TurnIqContractError) {
    return { ok: false, code: "stale_state" };
  }
  return { ok: false, code: "server_error" };
}

function rpcOutcomeFromReceiptResult(value: unknown): TurnIqRpcOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false };
  }
  const row = value as Row;
  return {
    ok: row.ok === true,
    code: typeof row.code === "string" ? row.code : undefined,
    command_id:
      typeof row.command_id === "string" ? row.command_id : undefined,
    replayed: true,
    assignment_id:
      typeof row.assignment_id === "string" ? row.assignment_id : undefined,
    status: typeof row.status === "string" ? row.status : undefined,
    state_version: Number.isSafeInteger(row.state_version)
      ? Number(row.state_version)
      : undefined,
  };
}

/**
 * Public Server Action core for M3C. The browser supplies identifiers only;
 * every policy, booking, capability, shift, resource and appointment-gap
 * value is reloaded from the authoritative salon-scoped database.
 */
export async function recommendTrustedTurnIqBooking(
  input: TurnIqRecommendationActionInput,
  now: () => string = () => new Date().toISOString(),
): Promise<TurnIqRecommendationActionResult> {
  try {
    const context = await resolveTurnIqContext(input.slug);
    if (!context) return { ok: false, code: "unauthorized" };
    if (!context.featureEnabled) return { ok: false, code: "feature_disabled" };
    if (!canUseTurnIqLiveBoard(context.role)) {
      return { ok: false, code: "forbidden" };
    }

    const capturedAt = now();
    const db = createServiceRoleClient();
    // Return a previously committed command before reloading mutable booking
    // state. This preserves exact-once success across transport retries even
    // after the booking or active policy has advanced.
    const receiptResult = await db
      .from("turniq_command_receipts" as never)
      .select(
        "salon_id, device_id, local_sequence, actor_user_id, actor_role, command_type, result" as never,
      )
      .eq("command_id" as never, input.commandId)
      .maybeSingle();
    if (receiptResult.error) throw databaseError(receiptResult.error);
    if (receiptResult.data) {
      const receipt = receiptResult.data as unknown as Row;
      if (
        receipt.salon_id !== context.salonId ||
        receipt.device_id !== input.deviceId ||
        safeInteger(receipt, "local_sequence", -1) !== input.localSequence ||
        receipt.actor_user_id !== context.actorUserId ||
        receipt.actor_role !== context.actorRole ||
        receipt.command_type !== "recommend"
      ) {
        return { ok: false, code: "idempotency_conflict" };
      }
      return resultFromRpc(rpcOutcomeFromReceiptResult(receipt.result));
    }
    const [salonResult, bookingResult] = await Promise.all([
      db
        .from("salons")
        .select("id, timezone, resources_enabled")
        .eq("id", context.salonId)
        .maybeSingle(),
      db
        .from("bookings")
        .select(
          "id, salon_id, service_id, addon_service_id, staff_id, staff_requested_by_client, created_at, start_time_utc, end_time_utc, status, schedule_model, party_size, group_id, resource_id, deleted_at",
        )
        .eq("id", input.bookingId)
        .eq("salon_id", context.salonId)
        .maybeSingle(),
    ]);
    if (salonResult.error) throw databaseError(salonResult.error);
    if (bookingResult.error) throw databaseError(bookingResult.error);
    if (!salonResult.data || !bookingResult.data) {
      return { ok: false, code: "not_found" };
    }
    const salon = salonResult.data as unknown as Row;
    const bookingRow = bookingResult.data as unknown as Row;
    if (bookingRow.deleted_at !== null) return { ok: false, code: "not_found" };
    const timezone = requiredString(salon, "timezone");
    const businessDate = salonYmdOfUtc(capturedAt, timezone);
    const bookingStart = requiredString(bookingRow, "start_time_utc");
    if (salonYmdOfUtc(bookingStart, timezone) !== businessDate) {
      return { ok: false, code: "stale_state" };
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
    if (!policyResult.data) return { ok: false, code: "stale_state" };
    const policy = policyFromRow(policyResult.data as unknown as Row);
    if (policy.timezone !== timezone) return { ok: false, code: "stale_state" };

    const serviceIds = [
      requiredString(bookingRow, "service_id"),
      nullableString(bookingRow, "addon_service_id"),
    ].filter((value): value is string => Boolean(value));
    const [servicesResult, staffResult, shiftResult, capabilityResult, occupiedResult, occupiedSegmentResult, resourceResult, addonCountResult] =
      await Promise.all([
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
        db
          .from("staff_services")
          .select("staff_id, service_id")
          .in("service_id", serviceIds),
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
            "id, staff_id, resource_id, occupied_start_utc, occupied_end_utc, reservation_status" as never,
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
          .select("id, kind, status")
          .eq("salon_id", context.salonId)
          .is("deleted_at", null),
        db
          .from("booking_addons")
          .select("id", { count: "exact", head: true })
          .eq("booking_id", input.bookingId),
      ]);
    for (const result of [
      servicesResult,
      staffResult,
      shiftResult,
      capabilityResult,
      occupiedResult,
      occupiedSegmentResult,
      resourceResult,
      addonCountResult,
    ]) {
      if (result.error) throw databaseError(result.error);
    }

    const booking: TurnIqTrustedBooking = {
      id: requiredString(bookingRow, "id"),
      salonId: requiredString(bookingRow, "salon_id"),
      serviceId: requiredString(bookingRow, "service_id"),
      addonServiceId: nullableString(bookingRow, "addon_service_id"),
      staffId: nullableString(bookingRow, "staff_id"),
      staffRequestedByClient: bookingRow.staff_requested_by_client === true,
      createdAt: requiredString(bookingRow, "created_at"),
      startAt: bookingStart,
      endAt: requiredString(bookingRow, "end_time_utc"),
      status: requiredString(bookingRow, "status") as TurnIqTrustedBooking["status"],
      scheduleModel: requiredString(bookingRow, "schedule_model"),
      partySize: Math.max(1, safeInteger(bookingRow, "party_size", 1)),
      groupId: nullableString(bookingRow, "group_id"),
      resourceId: nullableString(bookingRow, "resource_id"),
      hasBookingAddonRows: (addonCountResult.count ?? 0) > 0,
    };
    // Existing staff_id is an authoritative booking assignment, but the old
    // boolean does not prove who captured the customer's request. M3C never
    // silently rewrites or competes with that assignment; provenance-aware
    // appointment intake is a later additive contract.
    if (booking.staffId !== null) {
      return { ok: false, code: "stale_state" };
    }
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
      ...((occupiedSegmentResult.data ?? []) as unknown as Row[]).map((row) => ({
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
    const trusted = await buildTrustedTurnIqDecisionInput({
      salonId: context.salonId,
      resourcesEnabled: salon.resources_enabled === true,
      capturedAt,
      businessDate,
      policy,
      booking,
      services,
      staff,
      shifts,
      // Empty is authoritative (no technician is qualified); null is reserved
      // for a failed capability load, which is already handled above.
      capabilities,
      occupiedBookings,
      resources,
    });
    const outcome = await recordTrustedTurnIqRecommendation({
      slug: input.slug,
      decisionInput: trusted.decisionInput,
      resourceId: trusted.resourceId,
      confirmationSnapshot: trusted.confirmationSnapshot,
      commandId: input.commandId,
      deviceId: input.deviceId,
      localSequence: input.localSequence,
    });
    return resultFromRpc(outcome);
  } catch (error) {
    return mapFailure(error);
  }
}
