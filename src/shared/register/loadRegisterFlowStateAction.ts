"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Server-side fallback for the register-flow state that previously lived
 * exclusively in sessionStorage. Capability-based: anyone with a valid
 * unexpired completion token can read the payload (the token itself is
 * the secret); the server gates on TTL only.
 *
 * Returns `null` when the token is unknown / expired / malformed —
 * callers should treat it as "no state available" and surface a
 * generic flow-error in the UI rather than leaking lookup details.
 */

export type RegisterFlowState = {
  phoneDigits: string;
};

export async function loadRegisterFlowState(
  token: string,
): Promise<RegisterFlowState | null> {
  const trimmed = String(token ?? "").trim();
  if (trimmed.length === 0) return null;

  const supabase = createServiceRoleClient();
  // Cast: `payload` not yet in the auto-generated DB types.
  const builder = supabase.from("register_completion_tokens") as unknown as {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        maybeSingle: () => Promise<{
          data:
            | {
                token: string;
                phone: string;
                expires_at: string;
                payload: unknown;
              }
            | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
  const { data, error } = await builder
    .select("token, phone, expires_at, payload")
    .eq("token", trimmed)
    .maybeSingle();

  if (error) {
    console.error("[loadRegisterFlowState]", error);
    return null;
  }
  if (!data) return null;

  const expMs = data.expires_at ? Date.parse(data.expires_at) : NaN;
  if (!Number.isFinite(expMs) || expMs < Date.now()) return null;

  // Prefer the payload's phone_digits when present (forward-compat with
  // future shape changes); fall back to the column for older rows that
  // pre-date the payload migration.
  const fromPayload =
    data.payload && typeof data.payload === "object" &&
    typeof (data.payload as { phone_digits?: unknown }).phone_digits ===
      "string"
      ? String((data.payload as { phone_digits: string }).phone_digits).trim()
      : "";
  const phoneDigits =
    fromPayload.length > 0 ? fromPayload : String(data.phone ?? "").trim();

  if (phoneDigits.length === 0) return null;
  return { phoneDigits };
}
