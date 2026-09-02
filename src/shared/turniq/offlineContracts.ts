import { z } from "zod";

import { canonicalTurnIqJson, sha256TurnIqHex } from "@/shared/turniq/fingerprint";
import type { TurnIqLiveBoardView, TurnIqStaffView } from "@/shared/turniq/readModels";

const uuid = z.string().uuid();
const positiveSequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonNegativeVersion = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const TURNIQ_OFFLINE_SCHEMA_VERSION = 1 as const;

export const turnIqOfflineLeaseSchema = z.object({
  salonId: uuid,
  deviceId: uuid,
  actorUserId: uuid,
  generation: positiveSequence,
  status: z.enum(["primary", "revoked", "read_only"]),
  stateVersion: nonNegativeVersion,
  lastAckedSequence: nonNegativeVersion,
});

export type TurnIqOfflineLease = z.infer<typeof turnIqOfflineLeaseSchema>;

export const turnIqOfflineCommandBodySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("shift"),
    staffId: uuid,
    action: z.enum(["check_in", "check_out", "break", "return"]),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  z.object({
    type: z.literal("assignment"),
    assignmentId: uuid,
    action: z.enum(["confirm", "override", "start", "complete"]),
    assignedStaffId: uuid.optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  z.object({
    type: z.literal("walkin_intake"),
    localTicketId: uuid,
    serviceId: uuid,
    partySize: z.number().int().min(1).max(12),
    requestedStaffId: uuid.optional(),
  }),
  z.object({
    type: z.literal("service_update"),
    assignmentId: uuid,
    serviceId: uuid,
    // The current booking contract has one legacy add-on slot. Offline mode
    // permits only that single, zero-duration add-on; richer changes require
    // online schedule/resource revalidation.
    addonServiceIds: z.array(uuid).max(1),
  }),
]);

export type TurnIqOfflineCommandBody = z.infer<
  typeof turnIqOfflineCommandBodySchema
>;

export const turnIqOfflineCommandSchema = z.object({
  schemaVersion: z.literal(TURNIQ_OFFLINE_SCHEMA_VERSION),
  commandId: uuid,
  salonId: uuid,
  deviceId: uuid,
  deviceGeneration: positiveSequence,
  policyVersionId: uuid,
  localSequence: positiveSequence,
  expectedStateVersion: nonNegativeVersion,
  actorUserId: uuid,
  clientTimestamp: z.string().datetime({ offset: true }),
  snapshotFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  requestFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  body: turnIqOfflineCommandBodySchema,
});

export type TurnIqOfflineCommand = z.infer<typeof turnIqOfflineCommandSchema>;

export const TURNIQ_OFFLINE_CONFLICT_CODES = [
  "device_not_primary",
  "device_generation_stale",
  "sequence_gap",
  "stale_snapshot",
  "stale_policy",
  "command_conflict",
  "domain_conflict",
  "storage_corrupt",
] as const;

export type TurnIqOfflineConflictCode =
  (typeof TURNIQ_OFFLINE_CONFLICT_CODES)[number];

export type TurnIqOfflineQueueStatus =
  | "queued"
  | "syncing"
  | "committed"
  | "conflict";

export type TurnIqOfflineQueueRecord = {
  command: TurnIqOfflineCommand;
  status: TurnIqOfflineQueueStatus;
  result?: {
    aggregateId: string;
    status: string;
    stateVersion: number;
    fairnessReceiptId: string | null;
  };
  conflictCode?: TurnIqOfflineConflictCode;
  conflictId?: string;
};

export type TurnIqOfflineSnapshot<TPayload = unknown> = {
  schemaVersion: typeof TURNIQ_OFFLINE_SCHEMA_VERSION;
  salonId: string;
  policyVersionId: string;
  deviceId: string;
  deviceGeneration: number;
  actorUserId: string;
  lastAckedSequence: number;
  stateVersion: number;
  snapshotFingerprint: string;
  capturedAt: string;
  payload: TPayload;
};

export type TurnIqOfflineServiceCatalogEntry = {
  id: string;
  name: string;
  durationMinutes: number;
  isAddon: boolean;
};

export type TurnIqOfflineSnapshotPayload = {
  board: TurnIqLiveBoardView | null;
  staffView: TurnIqStaffView | null;
  services: readonly TurnIqOfflineServiceCatalogEntry[];
};

export type TurnIqOfflineStatus = {
  supported: boolean;
  mode: "online" | "primary_offline" | "read_only_offline" | "conflict";
  unsyncedCount: number;
  conflictCount: number;
  lastSyncedAt: string | null;
};

export const turnIqOfflineDeviceActionSchema = z.object({
  slug: z.string().trim().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  deviceId: uuid,
});

export const turnIqOfflinePairActionSchema = turnIqOfflineDeviceActionSchema.extend({
  label: z.string().trim().min(1).max(100),
});

export const turnIqOfflineRevokeActionSchema = turnIqOfflineDeviceActionSchema.extend({
  reason: z.string().trim().min(1).max(500),
});

export const turnIqOfflineSnapshotActionSchema = turnIqOfflineDeviceActionSchema.extend({
  deviceGeneration: positiveSequence,
  policyVersionId: uuid,
  snapshotFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  capturedAt: z.string().datetime({ offset: true }),
});

export const turnIqOfflineReplayActionSchema = z.object({
  slug: z.string().trim().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  command: turnIqOfflineCommandSchema,
});

export const turnIqOfflineReconcileActionSchema = turnIqOfflineDeviceActionSchema.extend({
  conflictId: uuid,
  reason: z.string().trim().min(1).max(500),
});

export type TurnIqOfflineReconcileActionResult =
  | { ok: true; conflictId: string; status: "resolved" }
  | { ok: false; code: "invalid_input" | "unauthorized" | "forbidden" | "feature_disabled" | "not_found" | "server_error" };

export type TurnIqOfflineDeviceActionResult =
  | { ok: true; lease: TurnIqOfflineLease }
  | {
      ok: false;
      code:
        | "invalid_input"
        | "unauthorized"
        | "forbidden"
        | "feature_disabled"
        | "not_found"
        | TurnIqOfflineConflictCode
        | "server_error";
    };

export type TurnIqOfflineReplayActionResult =
  | {
      ok: true;
      result: {
        commandId: string;
        replayed: boolean;
        aggregateId: string;
        status: string;
        stateVersion: number;
        offlineStateVersion: number;
        fairnessReceiptId: string | null;
      };
    }
  | {
      ok: false;
      code: TurnIqOfflineConflictCode | "invalid_input" | "unauthorized" | "forbidden" | "feature_disabled" | "server_error";
      conflictId?: string;
    };

export async function fingerprintTurnIqOfflineCommand(
  command: Omit<TurnIqOfflineCommand, "requestFingerprint">,
): Promise<string> {
  return sha256TurnIqHex(
    canonicalTurnIqJson({ kind: "turniq_primary_offline_command_v1", ...command }),
  );
}

export async function buildTurnIqOfflineCommand(input: {
  snapshot: TurnIqOfflineSnapshot;
  pendingCount: number;
  commandId: string;
  clientTimestamp: string;
  body: TurnIqOfflineCommandBody;
}): Promise<TurnIqOfflineCommand> {
  const draft: Omit<TurnIqOfflineCommand, "requestFingerprint"> = {
    schemaVersion: TURNIQ_OFFLINE_SCHEMA_VERSION,
    commandId: input.commandId,
    salonId: input.snapshot.salonId,
    deviceId: input.snapshot.deviceId,
    deviceGeneration: input.snapshot.deviceGeneration,
    policyVersionId: input.snapshot.policyVersionId,
    localSequence: input.snapshot.lastAckedSequence + input.pendingCount + 1,
    expectedStateVersion: input.snapshot.stateVersion + input.pendingCount,
    actorUserId: input.snapshot.actorUserId,
    clientTimestamp: input.clientTimestamp,
    snapshotFingerprint: input.snapshot.snapshotFingerprint,
    body: input.body,
  };
  return {
    ...draft,
    requestFingerprint: await fingerprintTurnIqOfflineCommand(draft),
  };
}

export function isOfflineCommandAllowed(body: TurnIqOfflineCommandBody): boolean {
  if (body.type === "shift") {
    return body.action !== "break" || Boolean(body.reason?.trim());
  }
  if (body.type === "assignment") {
    if (body.action === "confirm") return Boolean(body.assignedStaffId);
    if (body.action === "override") {
      return Boolean(body.assignedStaffId && body.reason?.trim());
    }
    return body.assignedStaffId === undefined && body.reason === undefined;
  }
  return true;
}
