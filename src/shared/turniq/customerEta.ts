import type { TurnIqConservativeEta } from "@/shared/turniq/contracts";
import {
  canonicalTurnIqJson,
  sha256TurnIqHex,
} from "@/shared/turniq/fingerprint";

const MINUTE_MS = 60_000;
const RANGE_CADENCE_MINUTES = 5;
const DEFAULT_MAX_SNAPSHOT_AGE_MINUTES = 5;

export const TURNIQ_CUSTOMER_ETA_REASON_CODES = [
  "ETA_FRESH_PLAN",
  "ETA_LAST_KNOWN_OFFLINE",
  "ETA_CONSERVATIVE_PADDING_APPLIED",
  "ETA_PARTY_RANGE_INCLUDED",
  "ETA_SNAPSHOT_STALE",
  "ETA_INSUFFICIENT_DATA",
  "ETA_STATUS_AUTHORITATIVE",
] as const;

export type TurnIqCustomerEtaReasonCode =
  (typeof TURNIQ_CUSTOMER_ETA_REASON_CODES)[number];

export type TurnIqCustomerEtaStatus =
  | "waiting"
  | "assigned"
  | "ready"
  | "in_service"
  | "completed"
  | "cancelled";

export type TurnIqCustomerEtaFreshness = "fresh" | "offline_last_known";

export type TurnIqCustomerEtaInput = {
  snapshotVersion: string;
  snapshotCapturedAt: string;
  nowIso: string;
  status: TurnIqCustomerEtaStatus;
  partySize: number;
  conservativeEta: TurnIqConservativeEta | null;
  /** Customer-specific start offset. Omit for a shared party-level view. */
  memberStartMinutes?: number;
  freshness: TurnIqCustomerEtaFreshness;
  maxSnapshotAgeMinutes?: number;
};

export type TurnIqCustomerEtaRange = {
  earliestMinutes: number;
  latestMinutes: number;
};

export type TurnIqCustomerEtaProjection = {
  version: 1;
  snapshotVersion: string;
  evaluatedAt: string;
  refreshBy: string;
  surface:
    | "waiting"
    | "last_known"
    | "updating"
    | "ready"
    | "in_service"
    | "completed"
    | "cancelled";
  stale: boolean;
  waitRange: TurnIqCustomerEtaRange | null;
  partyFullyStartedRange: TurnIqCustomerEtaRange | null;
  reasonCodes: readonly TurnIqCustomerEtaReasonCode[];
  message: { en: string; vi: string };
};

export type TurnIqCustomerEtaAccuracy = {
  outcome: "early" | "within_range" | "late";
  deviationMinutes: number;
  predictedWidthMinutes: number;
};

export class TurnIqCustomerEtaError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TurnIqCustomerEtaError";
  }
}

function parseIso(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TurnIqCustomerEtaError(code);
  return parsed;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TurnIqCustomerEtaError(code);
  }
  return value;
}

function floorCadence(value: number): number {
  return Math.floor(value / RANGE_CADENCE_MINUTES) * RANGE_CADENCE_MINUTES;
}

function ceilCadence(value: number): number {
  return Math.ceil(value / RANGE_CADENCE_MINUTES) * RANGE_CADENCE_MINUTES;
}

function nonExactRange(earliestMinutes: number, latestMinutes: number) {
  const earliest = Math.max(0, floorCadence(earliestMinutes));
  const roundedLatest = Math.max(0, ceilCadence(latestMinutes));
  return {
    earliestMinutes: earliest,
    latestMinutes: Math.max(
      earliest + RANGE_CADENCE_MINUTES,
      roundedLatest,
    ),
  } satisfies TurnIqCustomerEtaRange;
}

function statusProjection(
  input: TurnIqCustomerEtaInput,
  refreshBy: string,
  includeTransient: boolean,
): TurnIqCustomerEtaProjection | null {
  const common = {
    version: 1 as const,
    snapshotVersion: input.snapshotVersion,
    evaluatedAt: input.nowIso,
    refreshBy,
    stale: false,
    waitRange: null,
    partyFullyStartedRange: null,
    reasonCodes: ["ETA_STATUS_AUTHORITATIVE"] as const,
  };
  switch (input.status) {
    case "ready":
      if (!includeTransient) return null;
      return {
        ...common,
        surface: "ready",
        message: {
          en: "It is your turn. Please come to the front desk.",
          vi: "Đã đến lượt bạn. Vui lòng đến quầy tiếp tân.",
        },
      };
    case "in_service":
      if (!includeTransient) return null;
      return {
        ...common,
        surface: "in_service",
        message: {
          en: "Your service is in progress.",
          vi: "Dịch vụ của bạn đang được thực hiện.",
        },
      };
    case "completed":
      return {
        ...common,
        surface: "completed",
        message: {
          en: "Your visit is complete. Thank you.",
          vi: "Dịch vụ đã hoàn tất. Cảm ơn bạn.",
        },
      };
    case "cancelled":
      return {
        ...common,
        surface: "cancelled",
        message: {
          en: "This visit is no longer active.",
          vi: "Lượt hẹn này không còn hoạt động.",
        },
      };
    case "waiting":
    case "assigned":
      return null;
  }
}

function updatingProjection(
  input: TurnIqCustomerEtaInput,
  refreshBy: string,
  reason: "ETA_SNAPSHOT_STALE" | "ETA_INSUFFICIENT_DATA",
): TurnIqCustomerEtaProjection {
  return {
    version: 1,
    snapshotVersion: input.snapshotVersion,
    evaluatedAt: input.nowIso,
    refreshBy,
    surface: "updating",
    stale: reason === "ETA_SNAPSHOT_STALE",
    waitRange: null,
    partyFullyStartedRange: null,
    reasonCodes: [reason],
    message: {
      en: "We are safely updating your wait range. Please keep this page open.",
      vi: "Chúng tôi đang cập nhật khoảng chờ an toàn. Vui lòng giữ trang này mở.",
    },
  };
}

/**
 * Converts a server-owned TurnIQ ETA into a deliberately non-exact,
 * privacy-safe customer range. It never accepts staff, money, queue ranking or
 * customer identity, so those truths cannot leak through this projection.
 */
export function projectTurnIqCustomerEta(
  input: TurnIqCustomerEtaInput,
): TurnIqCustomerEtaProjection {
  if (!input.snapshotVersion.trim()) {
    throw new TurnIqCustomerEtaError("turniq_eta_missing_snapshot_version");
  }
  boundedInteger(input.partySize, 1, 12, "turniq_eta_invalid_party_size");
  const capturedAtMs = parseIso(
    input.snapshotCapturedAt,
    "turniq_eta_invalid_snapshot_time",
  );
  const nowMs = parseIso(input.nowIso, "turniq_eta_invalid_now");
  if (capturedAtMs > nowMs + MINUTE_MS) {
    throw new TurnIqCustomerEtaError("turniq_eta_snapshot_from_future");
  }
  const maxAgeMinutes = boundedInteger(
    input.maxSnapshotAgeMinutes ?? DEFAULT_MAX_SNAPSHOT_AGE_MINUTES,
    1,
    15,
    "turniq_eta_invalid_max_age",
  );
  const refreshByMs = capturedAtMs + maxAgeMinutes * MINUTE_MS;
  const refreshBy = new Date(refreshByMs).toISOString();

  const terminal = statusProjection(input, refreshBy, false);
  if (terminal) return terminal;

  if (nowMs > refreshByMs) {
    return updatingProjection(input, refreshBy, "ETA_SNAPSHOT_STALE");
  }
  const authoritative = statusProjection(input, refreshBy, true);
  if (authoritative) return authoritative;
  const eta = input.conservativeEta;
  if (!eta) {
    return updatingProjection(input, refreshBy, "ETA_INSUFFICIENT_DATA");
  }
  const earliest = boundedInteger(
    eta.earliestStartMinutes,
    0,
    12 * 60,
    "turniq_eta_invalid_earliest_start",
  );
  const allStarted = boundedInteger(
    eta.allStartedByMinutes,
    earliest,
    12 * 60,
    "turniq_eta_invalid_all_started_by",
  );
  const padding = boundedInteger(
    eta.confidencePaddingMinutes,
    0,
    60,
    "turniq_eta_invalid_padding",
  );
  const memberStart =
    input.memberStartMinutes === undefined
      ? null
      : boundedInteger(
          input.memberStartMinutes,
          0,
          allStarted,
          "turniq_eta_invalid_member_start",
        );
  const elapsedMinutes = Math.max(0, (nowMs - capturedAtMs) / MINUTE_MS);
  const waitRange = nonExactRange(
    (memberStart ?? earliest) - elapsedMinutes,
    (memberStart ?? allStarted) + padding - elapsedMinutes,
  );
  const partyFullyStartedRange =
    input.partySize > 1
      ? nonExactRange(
          allStarted - elapsedMinutes,
          allStarted + padding - elapsedMinutes,
        )
      : null;
  const lastKnown = input.freshness === "offline_last_known";
  const rangeText = `${waitRange.earliestMinutes}–${waitRange.latestMinutes}`;
  const reasonCodes: TurnIqCustomerEtaReasonCode[] = [
    lastKnown ? "ETA_LAST_KNOWN_OFFLINE" : "ETA_FRESH_PLAN",
    "ETA_CONSERVATIVE_PADDING_APPLIED",
  ];
  if (partyFullyStartedRange) reasonCodes.push("ETA_PARTY_RANGE_INCLUDED");

  return {
    version: 1,
    snapshotVersion: input.snapshotVersion,
    evaluatedAt: input.nowIso,
    refreshBy,
    surface: lastKnown ? "last_known" : "waiting",
    stale: false,
    waitRange,
    partyFullyStartedRange,
    reasonCodes,
    message: lastKnown
      ? {
          en: `Connection is limited. Last safe estimate: ${rangeText} minutes.`,
          vi: `Kết nối đang yếu. Ước tính an toàn gần nhất: ${rangeText} phút.`,
        }
      : {
          en: `Estimated start in ${rangeText} minutes. We will update this automatically if the salon changes.`,
          vi: `Dự kiến bắt đầu trong ${rangeText} phút. Hệ thống sẽ tự cập nhật nếu lịch thay đổi.`,
        },
  };
}

/** Privacy-safe identity for deduplicated ETA telemetry and observations. */
export async function fingerprintTurnIqCustomerEta(
  projection: TurnIqCustomerEtaProjection,
): Promise<string> {
  return sha256TurnIqHex(
    canonicalTurnIqJson({
      version: projection.version,
      snapshotVersion: projection.snapshotVersion,
      evaluatedAt: projection.evaluatedAt,
      refreshBy: projection.refreshBy,
      surface: projection.surface,
      stale: projection.stale,
      waitRange: projection.waitRange,
      partyFullyStartedRange: projection.partyFullyStartedRange,
      reasonCodes: projection.reasonCodes,
    }),
  );
}

/**
 * Measures whether the observed start fell inside the customer range. The
 * result contains no customer, booking, staff, money or tip fields.
 */
export function measureTurnIqCustomerEtaAccuracy(
  projection: TurnIqCustomerEtaProjection,
  observedStartAt: string,
): TurnIqCustomerEtaAccuracy {
  if (!projection.waitRange) {
    throw new TurnIqCustomerEtaError("turniq_eta_range_not_observable");
  }
  const evaluatedAtMs = parseIso(
    projection.evaluatedAt,
    "turniq_eta_invalid_evaluated_at",
  );
  const observedMs = parseIso(
    observedStartAt,
    "turniq_eta_invalid_observed_start",
  );
  const observedMinutes = (observedMs - evaluatedAtMs) / MINUTE_MS;
  const { earliestMinutes, latestMinutes } = projection.waitRange;
  if (observedMinutes < earliestMinutes) {
    return {
      outcome: "early",
      deviationMinutes: Math.ceil(earliestMinutes - observedMinutes),
      predictedWidthMinutes: latestMinutes - earliestMinutes,
    };
  }
  if (observedMinutes > latestMinutes) {
    return {
      outcome: "late",
      deviationMinutes: Math.ceil(observedMinutes - latestMinutes),
      predictedWidthMinutes: latestMinutes - earliestMinutes,
    };
  }
  return {
    outcome: "within_range",
    deviationMinutes: 0,
    predictedWidthMinutes: latestMinutes - earliestMinutes,
  };
}
