import "server-only";

import { isReleaseFeatureVisible } from "@/shared/features/platformFeatureFlags";
import type { ReleaseFeatureSalon } from "@/shared/features/featureRegistry";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  fingerprintTurnIqCustomerEta,
  projectTurnIqCustomerEta,
  type TurnIqCustomerEtaProjection,
  type TurnIqCustomerEtaStatus,
} from "@/shared/turniq/customerEta";
import {
  canonicalTurnIqJson,
  sha256TurnIqHex,
} from "@/shared/turniq/fingerprint";

const MINUTE_MS = 60_000;

type SalonFeatureRow = ReleaseFeatureSalon;

export type TurnIqCustomerStatusGroupPlanRow = {
  id: string;
  party_size: number;
  conservative_eta: unknown;
  updated_at: string;
};

export type TurnIqCustomerStatusGroupItemRow = {
  booking_id: string;
  starts_at: string;
};

export type TurnIqCustomerStatusAssignmentRow = {
  status: string;
  decision_timestamp: string;
  updated_at: string;
};

export type TurnIqCustomerStatusEtaRepository = {
  loadSalonFlags(salonId: string): Promise<SalonFeatureRow | null>;
  loadConfirmedGroupPlan(
    salonId: string,
    groupId: string,
  ): Promise<TurnIqCustomerStatusGroupPlanRow | null>;
  loadGroupPlanItems(
    salonId: string,
    planId: string,
  ): Promise<TurnIqCustomerStatusGroupItemRow[]>;
  loadActiveAssignment(
    salonId: string,
    bookingId: string,
  ): Promise<TurnIqCustomerStatusAssignmentRow | null>;
};

export type TurnIqCustomerStatusEtaInput = {
  salonId: string;
  bookingId: string;
  groupId: string | null;
  bookingStatus: string;
  currentStartTimeUtc: string;
  durationMinutes: number;
  nowIso?: string;
};

export type PublicTurnIqCustomerEta = Omit<
  TurnIqCustomerEtaProjection,
  "snapshotVersion"
> & {
  estimateFingerprint: string;
};

type LoaderDependencies = {
  repository?: TurnIqCustomerStatusEtaRepository;
  featureVisible?: (
    salon: ReleaseFeatureSalon,
    key: "turniq_trust_engine",
  ) => Promise<boolean>;
};

function validIso(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function minutesUntil(value: string, nowMs: number): number | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.ceil((timestamp - nowMs) / MINUTE_MS));
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) &&
      value >= minimum && value <= maximum
    ? value
    : null;
}

function confidencePadding(value: unknown, durationMinutes: number): number {
  if (value && typeof value === "object") {
    const parsed = boundedInteger(
      (value as Record<string, unknown>).confidencePaddingMinutes,
      0,
      60,
    );
    if (parsed !== null) return parsed;
  }
  return Math.min(60, Math.max(5, Math.ceil(durationMinutes * 0.15)));
}

function bookingStatus(value: string): TurnIqCustomerEtaStatus | null {
  switch (value.trim().toLowerCase()) {
    case "waiting":
    case "checked_in":
      return "waiting";
    case "pending":
    case "confirmed":
      return "assigned";
    case "in_progress":
      return "in_service";
    case "completed":
      return "completed";
    case "cancelled":
    case "canceled":
    case "no_show":
      return "cancelled";
    default:
      return null;
  }
}

function assignmentStatus(
  assignment: TurnIqCustomerStatusAssignmentRow,
  fallback: TurnIqCustomerEtaStatus,
): TurnIqCustomerEtaStatus {
  switch (assignment.status) {
    case "in_progress":
      return "in_service";
    case "completed":
      return "completed";
    case "cancelled":
    case "rejected":
      return "cancelled";
    case "recommended":
    case "confirmed":
      return fallback;
    default:
      return fallback;
  }
}

async function publicProjection(
  projection: TurnIqCustomerEtaProjection,
): Promise<PublicTurnIqCustomerEta> {
  const estimateFingerprint = await fingerprintTurnIqCustomerEta(projection);
  return {
    version: projection.version,
    evaluatedAt: projection.evaluatedAt,
    refreshBy: projection.refreshBy,
    surface: projection.surface,
    stale: projection.stale,
    waitRange: projection.waitRange,
    partyFullyStartedRange: projection.partyFullyStartedRange,
    reasonCodes: projection.reasonCodes,
    message: projection.message,
    estimateFingerprint,
  };
}

export function createTurnIqCustomerStatusEtaRepository(
  db = createServiceRoleClient(),
): TurnIqCustomerStatusEtaRepository {
  return {
    async loadSalonFlags(salonId) {
      const { data, error } = await db
        .from("salons")
        .select("subscription_plan, plan_override, feature_flags, voice_ai_enabled")
        .eq("id", salonId)
        .maybeSingle();
      if (error) throw error;
      return data as SalonFeatureRow | null;
    },
    async loadConfirmedGroupPlan(salonId, groupId) {
      const { data, error } = await db
        .from("turniq_group_plans" as never)
        .select("id, party_size, conservative_eta, updated_at" as never)
        .eq("salon_id", salonId)
        .eq("booking_group_id", groupId)
        .eq("status", "confirmed")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as TurnIqCustomerStatusGroupPlanRow | null;
    },
    async loadGroupPlanItems(salonId, planId) {
      const { data, error } = await db
        .from("turniq_group_plan_items" as never)
        .select("booking_id, starts_at" as never)
        .eq("salon_id", salonId)
        .eq("group_plan_id", planId)
        .order("item_position", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as TurnIqCustomerStatusGroupItemRow[];
    },
    async loadActiveAssignment(salonId, bookingId) {
      const { data, error } = await db
        .from("turniq_assignments" as never)
        .select("status, decision_timestamp, updated_at" as never)
        .eq("salon_id", salonId)
        .eq("booking_id", bookingId)
        .in("status", [
          "recommended",
          "confirmed",
          "in_progress",
          "completed",
          "cancelled",
          "rejected",
        ])
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as TurnIqCustomerStatusAssignmentRow | null;
    },
  };
}

/**
 * Loads only the minimum TurnIQ truth required for a capability-authenticated
 * customer status response. Any optional ETA failure returns null so the
 * canonical booking status remains available.
 */
export async function loadTurnIqCustomerStatusEta(
  input: TurnIqCustomerStatusEtaInput,
  dependencies: LoaderDependencies = {},
): Promise<PublicTurnIqCustomerEta | null> {
  try {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const nowMs = Date.parse(nowIso);
    const durationMinutes = boundedInteger(input.durationMinutes, 1, 12 * 60);
    const status = bookingStatus(input.bookingStatus);
    if (!Number.isFinite(nowMs) || !durationMinutes || !status) return null;

    const repository = dependencies.repository ??
      createTurnIqCustomerStatusEtaRepository();
    const salon = await repository.loadSalonFlags(input.salonId);
    if (!salon) return null;
    const featureVisible = dependencies.featureVisible ?? isReleaseFeatureVisible;
    if (!(await featureVisible(salon, "turniq_trust_engine"))) return null;

    if (input.groupId) {
      const plan = await repository.loadConfirmedGroupPlan(
        input.salonId,
        input.groupId,
      );
      if (!plan || !validIso(plan.updated_at)) return null;
      const partySize = boundedInteger(plan.party_size, 2, 12);
      if (!partySize) return null;
      const items = await repository.loadGroupPlanItems(input.salonId, plan.id);
      if (items.length !== partySize) return null;
      const waits = items.map((item) => minutesUntil(item.starts_at, nowMs));
      if (waits.some((wait) => wait === null || wait > 12 * 60)) return null;
      const ownIndex = items.findIndex((item) => item.booking_id === input.bookingId);
      if (ownIndex < 0) return null;
      const safeWaits = waits as number[];
      const earliest = Math.min(...safeWaits);
      const allStarted = Math.max(...safeWaits);
      const snapshotVersion = await sha256TurnIqHex(canonicalTurnIqJson({
        planUpdatedAt: plan.updated_at,
        startsAt: items.map((item) => item.starts_at),
        status,
      }));
      return publicProjection(projectTurnIqCustomerEta({
        snapshotVersion,
        snapshotCapturedAt: nowIso,
        nowIso,
        status,
        partySize,
        conservativeEta: {
          earliestStartMinutes: earliest,
          allStartedByMinutes: allStarted,
          confidencePaddingMinutes: confidencePadding(
            plan.conservative_eta,
            durationMinutes,
          ),
        },
        memberStartMinutes: safeWaits[ownIndex],
        freshness: "fresh",
      }));
    }

    const assignment = await repository.loadActiveAssignment(
      input.salonId,
      input.bookingId,
    );
    if (!assignment || !validIso(assignment.updated_at)) return null;
    const startMinutes = minutesUntil(input.currentStartTimeUtc, nowMs);
    if (startMinutes === null || startMinutes > 12 * 60) return null;
    const resolvedStatus = assignmentStatus(assignment, status);
    const snapshotVersion = await sha256TurnIqHex(canonicalTurnIqJson({
      assignmentUpdatedAt: assignment.updated_at,
      bookingStartAt: input.currentStartTimeUtc,
      status: resolvedStatus,
    }));
    return publicProjection(projectTurnIqCustomerEta({
      snapshotVersion,
      snapshotCapturedAt: nowIso,
      nowIso,
      status: resolvedStatus,
      partySize: 1,
      conservativeEta: {
        earliestStartMinutes: startMinutes,
        allStartedByMinutes: startMinutes,
        confidencePaddingMinutes: confidencePadding(null, durationMinutes),
      },
      memberStartMinutes: startMinutes,
      freshness: "fresh",
    }));
  } catch {
    return null;
  }
}
