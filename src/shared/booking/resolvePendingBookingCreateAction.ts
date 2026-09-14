"use server";

import { headers } from "next/headers";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { clientIpFromHeaders, durableRateLimitKey, isOverRateLimit } from "@/shared/lib/inAppRateLimit";
import { parsePendingGroupCreate } from "./pendingGroupCreate";

export type BookingCreateResolution =
  | { status: "retired" | "booking_exists"; salonPath: string }
  | { status: "pending" | "unavailable" };

/** Explicit customer action. Resolves only an opaque create authority; never cancels or recreates a booking. */
export async function resolvePendingBookingCreateAction(input: unknown): Promise<BookingCreateResolution> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { status: "unavailable" };
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !["kind", "salonId", "idempotencyKey", "pricingFingerprint"].includes(key)) ||
    typeof body.kind !== "string" || !["individual", "sequence", "group"].includes(body.kind) ||
    ![body.salonId, body.idempotencyKey, body.pricingFingerprint].every(value => typeof value === "string")) return { status: "unavailable" };
  const binding = parsePendingGroupCreate(`#group=${body.salonId}.${body.idempotencyKey}.${body.pricingFingerprint}`);
  if (!binding) return { status: "unavailable" };
  try {
    const requestHeaders = await headers();
    const origin = new URL(requestHeaders.get("origin") ?? "");
    const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
    if (!["http:", "https:"].includes(origin.protocol) || origin.host !== host) return { status: "unavailable" };
    if (await isOverRateLimit(durableRateLimitKey("resolve-pending-create", clientIpFromHeaders(requestHeaders), binding.salonId), 8, 300, { failureMode: "block" })) return { status: "unavailable" };
    const { data, error } = await createServiceRoleClient({ timeoutMs: 4000 }).rpc("resolve_pending_booking_create", {
      p_salon_id: binding.salonId, p_request_id: binding.idempotencyKey,
      p_kind: body.kind, p_pricing_fingerprint: binding.pricingFingerprint,
    });
    if (error || !data || typeof data !== "object" || Array.isArray(data)) return { status: "unavailable" };
    if (data.status === "pending") return { status: "pending" };
    if ((data.status === "retired" || data.status === "booking_exists") && typeof data.salon_slug === "string" && /^[a-z0-9][a-z0-9-]*$/.test(data.salon_slug)) {
      return { status: data.status, salonPath: `/${data.salon_slug}` };
    }
    return { status: "unavailable" };
  } catch { return { status: "unavailable" }; }
}
