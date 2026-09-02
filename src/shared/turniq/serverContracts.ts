import { z } from "zod";

import type { TurnIqGroupTimingComparisonView } from "@/shared/turniq/groupReadModels";

export const turnIqSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const uuid = z.string().uuid();
const positiveSequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const commandEnvelope = {
  slug: turnIqSlugSchema,
  policyVersionId: uuid,
  commandId: uuid,
  deviceId: uuid,
  localSequence: positiveSequence,
};

export const turnIqShiftActionInputSchema = z.object({
  ...commandEnvelope,
  staffId: uuid,
  command: z.discriminatedUnion("type", [
    z.object({ type: z.literal("check_in") }),
    z.object({ type: z.literal("check_out") }),
    z.object({ type: z.literal("break"), reason: z.string().trim().min(1).max(500) }),
    z.object({ type: z.literal("return") }),
    z.object({ type: z.literal("hold"), reason: z.string().trim().min(1).max(500) }),
    z.object({ type: z.literal("release_hold") }),
  ]),
});

export const turnIqAssignmentActionInputSchema = z.object({
  ...commandEnvelope,
  assignmentId: uuid,
  command: z.discriminatedUnion("type", [
    z.object({ type: z.literal("confirm"), assignedStaffId: uuid }),
    z.object({
      type: z.literal("override"),
      assignedStaffId: uuid,
      reason: z.string().trim().min(1).max(500),
    }),
    z.object({ type: z.literal("start") }),
    z.object({ type: z.literal("complete") }),
  ]),
});

export const turnIqRefusalActionInputSchema = z.object({
  ...commandEnvelope,
  assignmentId: uuid,
  command: z.object({
    type: z.literal("refuse"),
    category: z.enum([
      "customer_declined",
      "illness_emergency",
      "unapproved_refusal",
    ]),
    reason: z.string().trim().min(1).max(500),
  }),
});

export const turnIqRedoActionInputSchema = z.object({
  ...commandEnvelope,
  assignmentId: uuid,
  command: z.object({
    type: z.literal("redo"),
    originalAssignmentId: uuid,
    category: z.enum([
      "quality_issue",
      "customer_damage_or_change",
      "warranty_or_goodwill",
      "other",
    ]),
    note: z.string().trim().min(1).max(500),
  }),
});

export const turnIqSwapActionInputSchema = z.discriminatedUnion("type", [
  z.object({
    ...commandEnvelope,
    type: z.literal("request_swap"),
    assignmentId: uuid,
    toStaffId: uuid,
    reason: z.string().trim().min(1).max(500),
  }),
  z.object({
    ...commandEnvelope,
    type: z.literal("consent_swap"),
    swapId: uuid,
    decision: z.enum(["accepted", "rejected"]),
  }),
  z.object({
    ...commandEnvelope,
    type: z.literal("confirm_swap"),
    swapId: uuid,
  }),
]);

export const turnIqCorrectionActionInputSchema = z.object({
  ...commandEnvelope,
  assignmentId: uuid,
  actualStaffId: uuid,
  category: z.enum([
    "wrong_technician",
    "missed_handoff",
    "administrative_error",
    "other",
  ]),
  reason: z.string().trim().min(1).max(500),
});

export const turnIqReadActionInputSchema = z.object({
  slug: turnIqSlugSchema,
});

export const turnIqReceiptActionInputSchema = z.object({
  slug: turnIqSlugSchema,
  receiptId: uuid,
});

export const turnIqCreateDisputeActionInputSchema = z.object({
  ...commandEnvelope,
  fairnessReceiptId: uuid,
  command: z.object({
    type: z.literal("dispute"),
    category: z.enum([
      "assignment",
      "skip_reason",
      "turn_credit",
      "service_credit",
      "override",
      "other",
    ]),
    reason: z.string().trim().min(1).max(500),
  }),
});

export const turnIqCreateSkipDisputeActionInputSchema = z.object({
  ...commandEnvelope,
  assignmentId: uuid,
  command: z.object({
    type: z.literal("dispute"),
    category: z.enum(["assignment", "skip_reason", "other"]),
    reason: z.string().trim().min(1).max(500),
  }),
});

export const turnIqResolveDisputeActionInputSchema = z.object({
  ...commandEnvelope,
  disputeId: uuid,
  command: z.object({
    type: z.literal("resolve_dispute"),
    resolution: z.enum(["resolved", "dismissed"]),
    reason: z.string().trim().min(1).max(500),
  }),
});

export const turnIqExceptionActionInputSchema = z.object({
  ...commandEnvelope,
  exceptionId: uuid,
  command: z.discriminatedUnion("type", [
    z.object({ type: z.literal("acknowledge_exception") }),
    z.object({
      type: z.literal("resolve_exception"),
      reason: z.string().trim().min(1).max(500),
    }),
    z.object({
      type: z.literal("dismiss_exception"),
      reason: z.string().trim().min(1).max(500),
    }),
  ]),
});

/**
 * Browser-safe recommendation envelope. Policy, candidate, staff, resource,
 * provenance and decision fields are deliberately absent; the server derives
 * them from authoritative salon-scoped rows.
 */
export const turnIqRecommendationActionInputSchema = z.object({
  slug: turnIqSlugSchema,
  bookingId: uuid,
  commandId: uuid,
  deviceId: uuid,
  localSequence: positiveSequence,
});

/** Group decisions are rebuilt server-side; the browser supplies identifiers only. */
export const turnIqGroupRecommendationActionInputSchema = z.object({
  slug: turnIqSlugSchema,
  bookingGroupId: uuid,
  commandId: uuid,
  deviceId: uuid,
  localSequence: positiveSequence,
});

export const turnIqGroupConfirmationActionInputSchema = z.object({
  slug: turnIqSlugSchema,
  groupPlanId: uuid,
  commandId: uuid,
  deviceId: uuid,
  localSequence: positiveSequence,
  overrideReason: z.string().trim().min(1).max(500).optional(),
});

export const turnIqGroupPlanReadActionInputSchema = z.object({
  slug: turnIqSlugSchema,
  groupPlanId: uuid,
});

export const turnIqGroupTimingComparisonActionInputSchema = z.object({
  slug: turnIqSlugSchema,
  bookingGroupId: uuid,
  windowMinutes: z.number().int().min(15).max(720).multipleOf(5).default(240),
  finishOffsetMinutes: z
    .number()
    .int()
    .min(15)
    .max(720)
    .multipleOf(5)
    .default(120),
});

const sha256Fingerprint = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Browser-safe M4H selection receipt. The browser identifies the simulation it
 * saw, but cannot submit staff, resources, fairness values or assignment rows.
 * The server rebuilds the selected option from a fresh authoritative snapshot.
 */
export const turnIqStaggeredGroupPlanActionInputSchema = z.object({
  slug: turnIqSlugSchema,
  bookingGroupId: uuid,
  intent: z.enum(["start_together", "finish_together", "smart_wave"]),
  windowMinutes: z.number().int().min(15).max(720).multipleOf(5),
  finishOffsetMinutes: z.number().int().min(15).max(720).multipleOf(5),
  expectedSimulationId: uuid,
  expectedSimulationFingerprint: sha256Fingerprint,
  expectedSnapshotVersion: z.string().trim().min(1).max(120),
  comparedAt: z.iso.datetime({ offset: true }),
  commandId: uuid,
  deviceId: uuid,
  localSequence: positiveSequence,
});

export const turnIqStaggeredGroupConfirmationActionInputSchema = z.object({
  slug: turnIqSlugSchema,
  groupPlanId: uuid,
  expectedStateVersion: z.number().int().positive(),
  commandId: uuid,
  deviceId: uuid,
  localSequence: positiveSequence,
  overrideReason: z.string().trim().min(1).max(500).optional(),
});

export type TurnIqShiftActionInput = z.infer<typeof turnIqShiftActionInputSchema>;
export type TurnIqAssignmentActionInput = z.infer<
  typeof turnIqAssignmentActionInputSchema
>;
export type TurnIqRecommendationActionInput = z.infer<
  typeof turnIqRecommendationActionInputSchema
>;
export type TurnIqGroupRecommendationActionInput = z.infer<
  typeof turnIqGroupRecommendationActionInputSchema
>;
export type TurnIqGroupConfirmationActionInput = z.infer<
  typeof turnIqGroupConfirmationActionInputSchema
>;
export type TurnIqGroupTimingComparisonActionInput = z.infer<
  typeof turnIqGroupTimingComparisonActionInputSchema
>;
export type TurnIqStaggeredGroupPlanActionInput = z.infer<
  typeof turnIqStaggeredGroupPlanActionInputSchema
>;
export type TurnIqStaggeredGroupConfirmationActionInput = z.infer<
  typeof turnIqStaggeredGroupConfirmationActionInputSchema
>;
export type TurnIqRefusalActionInput = z.infer<
  typeof turnIqRefusalActionInputSchema
>;
export type TurnIqRedoActionInput = z.infer<typeof turnIqRedoActionInputSchema>;
export type TurnIqSwapActionInput = z.infer<typeof turnIqSwapActionInputSchema>;
export type TurnIqCorrectionActionInput = z.infer<
  typeof turnIqCorrectionActionInputSchema
>;
export type TurnIqCreateDisputeActionInput = z.infer<
  typeof turnIqCreateDisputeActionInputSchema
>;
export type TurnIqCreateSkipDisputeActionInput = z.infer<
  typeof turnIqCreateSkipDisputeActionInputSchema
>;
export type TurnIqResolveDisputeActionInput = z.infer<
  typeof turnIqResolveDisputeActionInputSchema
>;
export type TurnIqExceptionActionInput = z.infer<
  typeof turnIqExceptionActionInputSchema
>;

export type TurnIqServerActionErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "forbidden"
  | "feature_disabled"
  | "not_found"
  | "owner_confirmation_required"
  | "policy_configuration_required"
  | "idempotency_conflict"
  | "stale_state"
  | "server_error";

export type TurnIqCommandActionResult =
  | {
      ok: true;
      result: {
        commandId: string;
        replayed: boolean;
        aggregateId: string;
        status: string;
        stateVersion: number;
        fairnessReceiptId: string | null;
      };
    }
  | {
      ok: false;
      code: TurnIqServerActionErrorCode;
      exceptionId?: string;
    };

export type TurnIqRecommendationActionResult =
  | {
      ok: true;
      result: {
        commandId: string;
        replayed: boolean;
        assignmentId: string;
        status: string;
        stateVersion: number;
      };
    }
  | {
      ok: false;
      code: TurnIqServerActionErrorCode;
    };

export type TurnIqGroupCommandActionResult =
  | {
      ok: true;
      result: {
        commandId: string;
        replayed: boolean;
        groupPlanId: string;
        bookingGroupId: string;
        partySize: number;
        status: string;
        stateVersion: number;
        fairnessReceiptIds: readonly string[];
      };
    }
  | {
      ok: false;
      code: TurnIqServerActionErrorCode;
    };

export type TurnIqGroupTimingComparisonActionResult =
  | { ok: true; data: TurnIqGroupTimingComparisonView }
  | { ok: false; code: TurnIqServerActionErrorCode };
