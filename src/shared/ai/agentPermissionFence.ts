import "server-only";

import type { AiAgentFlagKey } from "@/shared/dashboard/aiAgentTypes";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Re-read an agent's owner-controlled permission immediately before an
 * external effect. Database errors fail closed so a stale in-memory flag can
 * never authorize another customer contact.
 */
export async function isAiAgentPermissionEnabled(
  salonId: string,
  flagKey: AiAgentFlagKey,
): Promise<boolean> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("salons")
    .select("feature_flags")
    .eq("id", salonId)
    .maybeSingle();

  if (error || !data) return false;
  const flags = (data as { feature_flags?: unknown }).feature_flags;
  return (
    !!flags &&
    typeof flags === "object" &&
    (flags as Record<string, unknown>)[flagKey] === true
  );
}
