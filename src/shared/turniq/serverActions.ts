"use server";

import {
  applyTurnIqExceptionCommandCore,
  applyTurnIqAssignmentCommandCore,
  applyTurnIqCorrectionCommandCore,
  applyTurnIqRefusalCommandCore,
  applyTurnIqRedoCommandCore,
  applyTurnIqShiftCommandCore,
  applyTurnIqSwapCommandCore,
  createTurnIqDisputeCore,
  createTurnIqSkipDisputeCore,
  resolveTurnIqDisputeCore,
} from "@/shared/turniq/actionCore";
import {
  loadTurnIqExceptionInbox,
  loadTurnIqFairnessReceipt,
  loadTurnIqLiveBoard,
  loadTurnIqStaffView,
  turnIqActionGateway,
  turnIqStaffPinGateway,
} from "@/shared/turniq/serverDal";
import {
  turnIqAssignmentActionInputSchema,
  turnIqCorrectionActionInputSchema,
  turnIqCreateDisputeActionInputSchema,
  turnIqCreateSkipDisputeActionInputSchema,
  turnIqExceptionActionInputSchema,
  turnIqGroupConfirmationActionInputSchema,
  turnIqGroupPlanReadActionInputSchema,
  turnIqGroupRecommendationActionInputSchema,
  turnIqGroupTimingComparisonActionInputSchema,
  turnIqHandoffConfirmationActionInputSchema,
  turnIqHandoffPerformerActionInputSchema,
  turnIqHandoffPlanReadActionInputSchema,
  turnIqHandoffRecommendationActionInputSchema,
  turnIqStaggeredGroupConfirmationActionInputSchema,
  turnIqStaggeredGroupPlanActionInputSchema,
  turnIqReadActionInputSchema,
  turnIqRecommendationActionInputSchema,
  turnIqReceiptActionInputSchema,
  turnIqResolveDisputeActionInputSchema,
  turnIqRefusalActionInputSchema,
  turnIqRedoActionInputSchema,
  turnIqShiftActionInputSchema,
  turnIqConfigureStaffPinInputSchema,
  turnIqPinShiftActionInputSchema,
  turnIqSwapActionInputSchema,
  type TurnIqAssignmentActionInput,
  type TurnIqCommandActionResult,
  type TurnIqCorrectionActionInput,
  type TurnIqCreateDisputeActionInput,
  type TurnIqCreateSkipDisputeActionInput,
  type TurnIqExceptionActionInput,
  type TurnIqResolveDisputeActionInput,
  type TurnIqRefusalActionInput,
  type TurnIqRedoActionInput,
  type TurnIqShiftActionInput,
  type TurnIqConfigureStaffPinInput,
  type TurnIqConfigureStaffPinActionResult,
  type TurnIqPinShiftActionInput,
  type TurnIqSwapActionInput,
} from "@/shared/turniq/serverContracts";
import {
  applyTurnIqPinShiftCommandCore,
  configureTurnIqStaffPinCore,
} from "@/shared/turniq/staffPin";
import {
  applyTrustedTurnIqHandoffPerformerCommand,
  confirmTrustedTurnIqHandoff,
  loadTrustedTurnIqHandoffPlan,
  loadTrustedTurnIqHandoffQueue,
  recommendTrustedTurnIqHandoff,
} from "@/shared/turniq/trustedHandoffRecommendation";
import {
  confirmTrustedTurnIqGroup,
  compareTrustedTurnIqGroupTiming,
  confirmTrustedTurnIqStaggeredGroupPlan,
  loadTrustedTurnIqGroupPlan,
  loadTrustedTurnIqGroupQueue,
  recommendTrustedTurnIqGroup,
  recordTrustedTurnIqStaggeredGroupPlan,
} from "@/shared/turniq/trustedGroupRecommendation";
import { recommendTrustedTurnIqBooking } from "@/shared/turniq/trustedRecommendation";

export async function applyTurnIqShiftCommandAction(
  input: TurnIqShiftActionInput,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqShiftActionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_input" };
  return applyTurnIqShiftCommandCore(
    parsed.data,
    turnIqActionGateway,
    () => new Date().toISOString(),
  );
}

export async function configureTurnIqStaffPinAction(
  input: TurnIqConfigureStaffPinInput,
): Promise<TurnIqConfigureStaffPinActionResult> {
  const parsed = turnIqConfigureStaffPinInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_input" };
  return configureTurnIqStaffPinCore(
    parsed.data,
    turnIqStaffPinGateway,
    () => new Date().toISOString(),
  );
}

export async function applyTurnIqPinShiftCommandAction(
  input: TurnIqPinShiftActionInput,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqPinShiftActionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_input" };
  return applyTurnIqPinShiftCommandCore(
    parsed.data,
    turnIqStaffPinGateway,
    () => new Date().toISOString(),
  );
}

export async function applyTurnIqAssignmentCommandAction(
  input: TurnIqAssignmentActionInput,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqAssignmentActionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_input" };
  return applyTurnIqAssignmentCommandCore(
    parsed.data,
    turnIqActionGateway,
    () => new Date().toISOString(),
  );
}

export async function applyTurnIqRefusalCommandAction(
  input: TurnIqRefusalActionInput,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqRefusalActionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_input" };
  return applyTurnIqRefusalCommandCore(
    parsed.data,
    turnIqActionGateway,
    () => new Date().toISOString(),
  );
}

export async function applyTurnIqRedoCommandAction(
  input: TurnIqRedoActionInput,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqRedoActionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_input" };
  return applyTurnIqRedoCommandCore(
    parsed.data,
    turnIqActionGateway,
    () => new Date().toISOString(),
  );
}

export async function applyTurnIqSwapCommandAction(
  input: TurnIqSwapActionInput,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqSwapActionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_input" };
  return applyTurnIqSwapCommandCore(
    parsed.data,
    turnIqActionGateway,
    () => new Date().toISOString(),
  );
}

export async function applyTurnIqCorrectionCommandAction(
  input: TurnIqCorrectionActionInput,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqCorrectionActionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_input" };
  return applyTurnIqCorrectionCommandCore(
    parsed.data,
    turnIqActionGateway,
    () => new Date().toISOString(),
  );
}

export async function createTurnIqDisputeAction(
  input: TurnIqCreateDisputeActionInput,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqCreateDisputeActionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_input" };
  return createTurnIqDisputeCore(
    parsed.data,
    turnIqActionGateway,
    () => new Date().toISOString(),
  );
}

export async function createTurnIqSkipDisputeAction(
  input: TurnIqCreateSkipDisputeActionInput,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqCreateSkipDisputeActionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_input" };
  return createTurnIqSkipDisputeCore(
    parsed.data,
    turnIqActionGateway,
    () => new Date().toISOString(),
  );
}

export async function resolveTurnIqDisputeAction(
  input: TurnIqResolveDisputeActionInput,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqResolveDisputeActionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_input" };
  return resolveTurnIqDisputeCore(
    parsed.data,
    turnIqActionGateway,
    () => new Date().toISOString(),
  );
}

export async function applyTurnIqExceptionCommandAction(
  input: TurnIqExceptionActionInput,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqExceptionActionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_input" };
  return applyTurnIqExceptionCommandCore(
    parsed.data,
    turnIqActionGateway,
    () => new Date().toISOString(),
  );
}

export async function recommendTurnIqBookingAction(input: unknown) {
  const parsed = turnIqRecommendationActionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, code: "invalid_input" as const };
  }
  return recommendTrustedTurnIqBooking(parsed.data);
}

export async function recommendTurnIqGroupAction(input: unknown) {
  const parsed = turnIqGroupRecommendationActionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, code: "invalid_input" as const };
  }
  return recommendTrustedTurnIqGroup(parsed.data);
}

export async function confirmTurnIqGroupAction(input: unknown) {
  const parsed = turnIqGroupConfirmationActionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, code: "invalid_input" as const };
  }
  return confirmTrustedTurnIqGroup(parsed.data);
}

export async function recommendTurnIqHandoffAction(input: unknown) {
  const parsed = turnIqHandoffRecommendationActionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, code: "invalid_input" as const };
  }
  return recommendTrustedTurnIqHandoff(parsed.data);
}

export async function confirmTurnIqHandoffAction(input: unknown) {
  const parsed = turnIqHandoffConfirmationActionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, code: "invalid_input" as const };
  }
  return confirmTrustedTurnIqHandoff(parsed.data);
}

export async function applyTurnIqHandoffPerformerAction(input: unknown) {
  const parsed = turnIqHandoffPerformerActionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, code: "invalid_input" as const };
  }
  return applyTrustedTurnIqHandoffPerformerCommand(parsed.data);
}

export async function loadTurnIqHandoffPlanAction(input: unknown) {
  const parsed = turnIqHandoffPlanReadActionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, code: "invalid_input" as const };
  }
  return loadTrustedTurnIqHandoffPlan(parsed.data.slug, parsed.data.handoffPlanId);
}

export async function loadTurnIqHandoffQueueAction(input: unknown) {
  const parsed = turnIqReadActionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, code: "invalid_input" as const };
  }
  return loadTrustedTurnIqHandoffQueue(parsed.data.slug);
}

export async function loadTurnIqGroupPlanAction(input: unknown) {
  const parsed = turnIqGroupPlanReadActionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, code: "invalid_input" as const };
  }
  return loadTrustedTurnIqGroupPlan(parsed.data.slug, parsed.data.groupPlanId);
}

export async function loadTurnIqGroupQueueAction(input: unknown) {
  const parsed = turnIqReadActionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, code: "invalid_input" as const };
  }
  return loadTrustedTurnIqGroupQueue(parsed.data.slug);
}

export async function compareTurnIqGroupTimingAction(input: unknown) {
  const parsed = turnIqGroupTimingComparisonActionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, code: "invalid_input" as const };
  }
  return compareTrustedTurnIqGroupTiming(parsed.data);
}

export async function recordTurnIqStaggeredGroupPlanAction(input: unknown) {
  const parsed = turnIqStaggeredGroupPlanActionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, code: "invalid_input" as const };
  }
  return recordTrustedTurnIqStaggeredGroupPlan(parsed.data);
}

export async function confirmTurnIqStaggeredGroupPlanAction(input: unknown) {
  const parsed = turnIqStaggeredGroupConfirmationActionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, code: "invalid_input" as const };
  }
  return confirmTrustedTurnIqStaggeredGroupPlan(parsed.data);
}

export async function loadTurnIqLiveBoardAction(input: { slug: string }) {
  const parsed = turnIqReadActionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "invalid_input" as const };
  return loadTurnIqLiveBoard(parsed.data.slug);
}

export async function loadTurnIqStaffViewAction(input: { slug: string }) {
  const parsed = turnIqReadActionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "invalid_input" as const };
  return loadTurnIqStaffView(parsed.data.slug);
}

export async function loadTurnIqFairnessReceiptAction(input: {
  slug: string;
  receiptId: string;
}) {
  const parsed = turnIqReceiptActionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "invalid_input" as const };
  return loadTurnIqFairnessReceipt(parsed.data.slug, parsed.data.receiptId);
}

export async function loadTurnIqExceptionInboxAction(input: { slug: string }) {
  const parsed = turnIqReadActionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "invalid_input" as const };
  return loadTurnIqExceptionInbox(parsed.data.slug);
}
