import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WaitlistClaimPreview =
  | { state: "available" }
  | { state: "unavailable" }
  | { state: "error" };

export type WaitlistClaimResult =
  | { ok: true; outcome: "booked" | "claimed" }
  | { ok: false; reason: "unavailable" | "error" };

export function parseWaitlistClaimToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  return UUID_PATTERN.test(token) ? token.toLowerCase() : null;
}

/** Read-only scanner/browser preview. No customer PII and no mutating RPC. */
export async function loadWaitlistClaimPreview(
  token: string,
): Promise<WaitlistClaimPreview> {
  const parsed = parseWaitlistClaimToken(token);
  if (!parsed) return { state: "unavailable" };

  try {
    const supabase = createServiceRoleClient();
    const { data, error } = await supabase.rpc(
      "inspect_waitlist_claim_capability" as never,
      { p_token_id: parsed } as never,
    );

    if (error) return { state: "error" };
    const row = data && typeof data === "object" && !Array.isArray(data)
      ? data as Record<string, unknown>
      : null;
    return row?.ok === true && row.code === "available"
      ? { state: "available" }
      : { state: "unavailable" };
  } catch {
    return { state: "error" };
  }
}

/** Sole application mutation boundary. It exposes no RPC customer fields. */
export async function claimWaitlistSlot(
  token: string,
  requestId: string,
): Promise<WaitlistClaimResult> {
  const parsed = parseWaitlistClaimToken(token);
  const parsedRequestId = parseWaitlistClaimToken(requestId);
  if (!parsed || !parsedRequestId) return { ok: false, reason: "unavailable" };

  try {
    const supabase = createServiceRoleClient();
    const { data, error } = await supabase.rpc(
      "claim_waitlist_with_management_capability" as never,
      { p_token_id: parsed, p_request_id: parsedRequestId } as never,
    );

    if (error) return { ok: false, reason: "error" };
    const row = data && typeof data === "object" && !Array.isArray(data)
      ? data as Record<string, unknown>
      : null;
    if (!row || row.ok !== true || (row.outcome !== "booked" && row.outcome !== "claimed") ||
        typeof row.idempotent !== "boolean") {
      return row?.ok === false ? { ok: false, reason: "unavailable" } : { ok: false, reason: "error" };
    }

    return {
      ok: true,
      outcome: row.outcome,
    };
  } catch {
    return { ok: false, reason: "error" };
  }
}
