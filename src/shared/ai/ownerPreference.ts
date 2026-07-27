import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  setOwnerProposalPreference,
  type OwnerPreferenceMutation,
} from "@/shared/ai/lessonMutations";

export const OWNER_PREFERENCE_COOLDOWN_DAYS = 28;

export type OwnerPreferenceDecisionRow = {
  status: "approved" | "declined";
  decided_at: string | null;
};

export type OwnerPreferenceDecision =
  | { action: "activate"; suppressUntil: string }
  | { action: "recover"; suppressUntil: null }
  | { action: "hold"; suppressUntil: null };

/**
 * Require repeated owner feedback before changing future proposal behavior.
 *
 * Two declines in the latest three decisions activate a temporary cooldown.
 * Two consecutive approvals recover the preference. Everything between those
 * thresholds is hysteresis: keep the current state rather than oscillating.
 */
export function decideOwnerProposalPreference(
  decisions: OwnerPreferenceDecisionRow[],
  now = new Date(),
): OwnerPreferenceDecision {
  const resolved = decisions
    .filter(
      (decision) =>
        (decision.status === "approved" || decision.status === "declined") &&
        decision.decided_at,
    )
    .sort(
      (left, right) =>
        new Date(right.decided_at!).getTime() -
        new Date(left.decided_at!).getTime(),
    );

  if (
    resolved.length >= 2 &&
    resolved[0].status === "approved" &&
    resolved[1].status === "approved"
  ) {
    return { action: "recover", suppressUntil: null };
  }

  const latestThree = resolved.slice(0, 3);
  const declines = latestThree.filter(
    (decision) => decision.status === "declined",
  ).length;
  if (latestThree.length === 3 && declines >= 2) {
    return {
      action: "activate",
      suppressUntil: new Date(
        now.getTime() + OWNER_PREFERENCE_COOLDOWN_DAYS * 86_400_000,
      ).toISOString(),
    };
  }

  return { action: "hold", suppressUntil: null };
}

export type OwnerPreferenceRefreshResult = OwnerPreferenceMutation & {
  action: OwnerPreferenceDecision["action"];
};

/**
 * Recalculate one salon/action preference from its own resolved approval
 * history. The source filter prevents unrelated bulk-message workflows from
 * teaching the weekly strategist.
 */
export async function refreshOwnerProposalPreference(params: {
  salonId: string;
  actionType: string;
  proposalSource?: string | null;
  now?: Date;
}): Promise<OwnerPreferenceRefreshResult> {
  const db = createServiceRoleClient();
  let query = db
    .from("approval_requests" as never)
    .select("status, decided_at")
    .eq("salon_id" as never, params.salonId)
    .eq("action_type" as never, params.actionType)
    .in("status" as never, ["approved", "declined"])
    .not("decided_at" as never, "is", null)
    .order("decided_at" as never, { ascending: false })
    .limit(5);

  if (params.proposalSource) {
    query = query.eq(
      "payload->>proposal_source" as never,
      params.proposalSource,
    );
  }

  const { data, error } = await query;
  if (error) {
    console.error("[refreshOwnerProposalPreference] history", error);
    return {
      lessonId: null,
      changed: false,
      active: false,
      action: "hold",
    };
  }

  const decision = decideOwnerProposalPreference(
    (data ?? []) as OwnerPreferenceDecisionRow[],
    params.now,
  );
  if (decision.action === "hold") {
    return {
      lessonId: null,
      changed: false,
      active: false,
      action: "hold",
    };
  }

  const mutation = await setOwnerProposalPreference({
    salonId: params.salonId,
    actionType: params.actionType,
    proposalSource: params.proposalSource ?? null,
    active: decision.action === "activate",
    suppressUntil: decision.suppressUntil,
  });
  return { ...mutation, action: decision.action };
}
