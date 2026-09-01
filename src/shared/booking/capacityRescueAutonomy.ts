import type { CapacityRescueKind } from "@/shared/booking/submitCapacityRescueRequest";

export type CapacityRescueAutonomyLane =
  | "auto_safe"
  | "approval_required"
  | "human_exception";

export type CapacityRescueAutonomyReason =
  | "watching_for_exact_slot"
  | "customer_response_pending"
  | "exact_plan_required"
  | "booking_commit_pending"
  | "unsafe_state_combination";

export type CapacityRescueAutonomyDecision = {
  lane: CapacityRescueAutonomyLane;
  reason: CapacityRescueAutonomyReason;
  /** Complex requests must never enter the single-slot invitation worker. */
  canUseSingleSlotInvitation: boolean;
  /** One-tap approval is truthful only after an executable plan exists. */
  canShowApprovalAction: boolean;
};

type CapacityRescueAutonomyInput = {
  requestKind: CapacityRescueKind;
  status: string;
  hasExecutablePlan?: boolean;
};

/**
 * Product-owned safety boundary for Smart Capacity Rescue.
 *
 * This classifier is deliberately deterministic and does not infer missing
 * capacity. An individual request may use the existing exact-slot invitation
 * lifecycle. Group and multi-service sequence requests stay out of that worker
 * until a separately validated, executable plan exists. Claimed entries still
 * require the final booking commit to be reconciled by staff.
 */
export function classifyCapacityRescueAutonomy({
  requestKind,
  status,
  hasExecutablePlan = false,
}: CapacityRescueAutonomyInput): CapacityRescueAutonomyDecision {
  if (requestKind === "individual") {
    if (status === "waiting") {
      return {
        lane: "auto_safe",
        reason: "watching_for_exact_slot",
        canUseSingleSlotInvitation: true,
        canShowApprovalAction: false,
      };
    }
    if (status === "notified") {
      return {
        lane: "auto_safe",
        reason: "customer_response_pending",
        canUseSingleSlotInvitation: true,
        canShowApprovalAction: false,
      };
    }
    if (status === "claimed") {
      return {
        lane: "human_exception",
        reason: "booking_commit_pending",
        canUseSingleSlotInvitation: false,
        canShowApprovalAction: false,
      };
    }
    return {
      lane: "human_exception",
      reason: "unsafe_state_combination",
      canUseSingleSlotInvitation: false,
      canShowApprovalAction: false,
    };
  }

  if (status === "review_required") {
    return {
      lane: "approval_required",
      reason: "exact_plan_required",
      canUseSingleSlotInvitation: false,
      canShowApprovalAction: hasExecutablePlan,
    };
  }

  // A complex request in waiting/notified/claimed is an invariant violation,
  // not permission to reuse the individual waitlist worker.
  return {
    lane: "human_exception",
    reason: "unsafe_state_combination",
    canUseSingleSlotInvitation: false,
    canShowApprovalAction: false,
  };
}
