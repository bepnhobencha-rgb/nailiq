import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type StripeWebhookClaim = {
  outcome: "acquired" | "duplicate" | "in_progress" | "conflict" | "invalid";
  leaseToken: string | null;
  attemptCount: number;
};

type StripeWebhookClaimRow = {
  outcome?: unknown;
  lease_token?: unknown;
  attempt_count?: unknown;
};

function parseClaim(value: unknown): StripeWebhookClaim {
  const row = (Array.isArray(value) ? value[0] : value) as
    | StripeWebhookClaimRow
    | null
    | undefined;
  const outcome = row?.outcome;
  if (
    outcome !== "acquired" &&
    outcome !== "duplicate" &&
    outcome !== "in_progress" &&
    outcome !== "conflict" &&
    outcome !== "invalid"
  ) {
    throw new Error("stripe_webhook_claim_invalid");
  }
  return {
    outcome,
    leaseToken:
      typeof row?.lease_token === "string" && row.lease_token.length > 0
        ? row.lease_token
        : null,
    attemptCount:
      typeof row?.attempt_count === "number" &&
      Number.isInteger(row.attempt_count) &&
      row.attempt_count >= 0
        ? row.attempt_count
        : 0,
  };
}

export async function claimStripeWebhookEvent(input: {
  eventId: string;
  eventType: string;
  now: Date;
}): Promise<StripeWebhookClaim> {
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(
    "claim_stripe_webhook_event" as never,
    {
      p_event_id: input.eventId,
      p_event_type: input.eventType,
      p_now: input.now.toISOString(),
    } as never,
  );
  if (error) throw new Error("stripe_webhook_claim_failed");
  return parseClaim(data);
}

export async function finishStripeWebhookEvent(input: {
  eventId: string;
  leaseToken: string;
  outcome: "processed" | "failed";
  errorCode?: string | null;
  now: Date;
}): Promise<boolean> {
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(
    "finish_stripe_webhook_event" as never,
    {
      p_event_id: input.eventId,
      p_lease_token: input.leaseToken,
      p_outcome: input.outcome,
      p_error_code: input.errorCode ?? null,
      p_now: input.now.toISOString(),
    } as never,
  );
  if (error) throw new Error("stripe_webhook_finish_failed");
  return data === true;
}
