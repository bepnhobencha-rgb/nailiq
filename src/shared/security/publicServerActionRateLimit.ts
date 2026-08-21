import "server-only";

import { headers } from "next/headers";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  clientIpFromHeaders,
  durableRateLimitKey,
} from "@/shared/lib/inAppRateLimit";

export type DurableRateLimitResult = "allowed" | "limited" | "unavailable";

export type DurableRateLimitBucket = {
  name: string;
  material: string[];
  limit: number;
  windowSeconds: number;
};

export async function consumeDurableRateLimitBuckets(
  scope: string,
  buckets: readonly DurableRateLimitBucket[],
): Promise<DurableRateLimitResult> {
  try {
    const db = createServiceRoleClient();
    for (const bucket of buckets) {
      if (
        !bucket.name ||
        bucket.material.length === 0 ||
        !Number.isSafeInteger(bucket.limit) ||
        bucket.limit < 1 ||
        !Number.isSafeInteger(bucket.windowSeconds) ||
        bucket.windowSeconds < 1
      ) {
        return "unavailable";
      }
      const { data, error } = await db.rpc("rate_limit_hit", {
        p_key: durableRateLimitKey(
          `public:${scope}:${bucket.name}`,
          ...bucket.material,
        ),
        p_limit: bucket.limit,
        p_window_seconds: bucket.windowSeconds,
      });
      if (error || typeof data !== "boolean") return "unavailable";
      if (!data) return "limited";
    }
    return "allowed";
  } catch {
    return "unavailable";
  }
}

export async function consumePublicServerActionRateLimit(input: {
  scope: string;
  identity: string;
  ipLimits?: readonly [limit: number, windowSeconds: number][];
  identityLimits?: readonly [limit: number, windowSeconds: number][];
}): Promise<DurableRateLimitResult> {
  const incoming = await headers();
  const ip = clientIpFromHeaders(incoming);
  const identity = input.identity.trim().toLowerCase();
  if (!identity) return "unavailable";

  const ipLimits = input.ipLimits ?? [
    [10, 300],
    [50, 3_600],
  ];
  const identityLimits = input.identityLimits ?? [
    [5, 300],
    [20, 3_600],
  ];

  return consumeDurableRateLimitBuckets(input.scope, [
    ...ipLimits.map(([limit, windowSeconds], index) => ({
      name: `ip-${index}`,
      material: [ip],
      limit,
      windowSeconds,
    })),
    ...identityLimits.map(([limit, windowSeconds], index) => ({
      name: `identity-${index}`,
      material: [identity],
      limit,
      windowSeconds,
    })),
  ]);
}

/** Route-handler counterpart. Caller material is accepted only in memory and
 * is irreversibly hashed by `consumeDurableRateLimitBuckets` before persistence. */
export async function consumePublicRequestRateLimit(input: {
  request: Request;
  scope: string;
  identity?: readonly string[];
  ipLimits?: readonly [limit: number, windowSeconds: number][];
  identityLimits?: readonly [limit: number, windowSeconds: number][];
}): Promise<DurableRateLimitResult> {
  const ipLimits = input.ipLimits ?? [[120, 60]];
  const identity = (input.identity ?? [])
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const identityLimits = input.identityLimits ?? [];
  if (identityLimits.length > 0 && identity.length === 0) return "unavailable";

  return consumeDurableRateLimitBuckets(input.scope, [
    ...ipLimits.map(([limit, windowSeconds], index) => ({
      name: `ip-${index}`,
      material: [clientIpFromHeaders(input.request.headers)],
      limit,
      windowSeconds,
    })),
    ...identityLimits.map(([limit, windowSeconds], index) => ({
      name: `identity-${index}`,
      material: identity,
      limit,
      windowSeconds,
    })),
  ]);
}
