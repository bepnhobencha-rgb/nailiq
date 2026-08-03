import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export async function claimAiExecutionSlot(input: {
  salonId: string;
  feature: string;
  dedupeKey: string;
  windowSeconds: number;
  maxCalls: number;
}): Promise<boolean> {
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "claim_ai_execution_slot" as never,
      {
        p_salon_id: input.salonId,
        p_feature: input.feature,
        p_dedupe_key: input.dedupeKey,
        p_window_seconds: input.windowSeconds,
        p_max_calls: input.maxCalls,
      } as never,
    );
    if (error) {
      console.error("[claimAiExecutionSlot] unavailable", error.code ?? "rpc_error");
      return false;
    }
    return data === true;
  } catch (error) {
    console.error(
      "[claimAiExecutionSlot] unavailable",
      error instanceof Error ? error.name : "unknown_error",
    );
    return false;
  }
}

export function ruleFirstOptimizationEnabled(
  flags: Record<string, unknown> | null | undefined,
): boolean {
  return flags?.ai_rule_first_optimization === true;
}
