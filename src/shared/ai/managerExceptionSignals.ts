import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type ManagerExceptionSignal = {
  agent: string;
  status: "ok" | "failed";
};

export function buildManagerExceptionSignals(
  result: Record<string, unknown>,
): ManagerExceptionSignal[] {
  return Object.entries(result)
    .filter(
      ([agent, status]) =>
        agent !== "salon" &&
        /^[a-z][a-z0-9_]{0,49}$/.test(agent) &&
        (status === "ok" || status === "failed"),
    )
    .map(([agent, status]) => ({
      agent,
      status: status as "ok" | "failed",
    }))
    .slice(0, 50);
}

export async function syncManagerExceptionSignals(
  salonId: string,
  result: Record<string, unknown>,
  now = new Date(),
): Promise<void> {
  const signals = buildManagerExceptionSignals(result);
  if (signals.length === 0) return;

  const db = createServiceRoleClient();
  const { error } = await db.rpc(
    "sync_ai_manager_operational_exceptions" as never,
    {
      p_salon_id: salonId,
      p_signals: signals,
      p_now: now.toISOString(),
    } as never,
  );
  if (error) throw new Error(error.message);
}
