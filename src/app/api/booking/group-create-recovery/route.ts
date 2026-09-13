import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { clientIp, durableRateLimitKey, isOverRateLimit } from "@/shared/lib/inAppRateLimit";
import { readJsonObjectWithLimit } from "@/shared/security/readJsonObjectWithLimit";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";
import { parsePendingGroupCreate } from "@/shared/booking/pendingGroupCreate";
import { committedCardRecoveryHref } from "@/shared/booking/committedCardRecovery";

const headers = { "Cache-Control": "private, no-store, max-age=0", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" };
const reply = (status: string, code = 200, recoveryHref?: string) => NextResponse.json({ ok: code === 200, status, ...(recoveryHref ? { recoveryHref } : {}) }, { status: code, headers });

/** Read existing authority only. Never create, mint, reconcile a provider or send. */
export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return reply("forbidden", 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return reply("invalid_request", 400);
  const body = await readJsonObjectWithLimit(request, 1024);
  if (!body || Object.keys(body).some(key => !["salonId", "idempotencyKey", "pricingFingerprint"].includes(key))) return reply("invalid_request", 400);
  const binding = parsePendingGroupCreate(`#group=${body.salonId}.${body.idempotencyKey}.${body.pricingFingerprint}`);
  if (!binding) return reply("invalid_request", 400);
  try {
    if (await isOverRateLimit(durableRateLimitKey("group-create-recovery", clientIp(request), binding.salonId), 12, 300, { failureMode: "block" })) return reply("unavailable", 429);
    const db = createServiceRoleClient({ timeoutMs: 4000 });
    const { data, error } = await db.from("bookings")
      .select("id,group_id,group_size,created_at,start_time_utc,public_booking_request_fingerprint,public_booking_pricing_snapshot")
      .eq("salon_id", binding.salonId).eq("idempotency_key", binding.idempotencyKey)
      .eq("public_booking_pricing_fingerprint", binding.pricingFingerprint)
      .eq("is_group_organizer", true).eq("status", "confirmed")
      .is("deleted_at", null).is("recovered_from_booking_id", null).not("group_id", "is", null).limit(2);
    if (error) return reply("unavailable", 503);
    // A missing read is not proof that the original transaction failed.
    if (!data?.length) return reply("pending");
    if (data.length !== 1) return reply("unavailable", 503);
    const row = data[0];
    const snapshot = row.public_booking_pricing_snapshot;
    const ids = snapshot?.booking_ids;
    if (!snapshot || snapshot.group_id !== row.group_id || snapshot.pricing_fingerprint !== binding.pricingFingerprint ||
      !/^[0-9a-f]{64}$/.test(row.public_booking_request_fingerprint ?? "") || !Array.isArray(ids) || ids.length < 2 ||
      ids.length !== row.group_size || ids[0] !== row.id || new Set(ids).size !== ids.length) return reply("unavailable", 503);
    const expiry = Math.min(Date.parse(row.created_at) + 30 * 60_000, Date.parse(row.start_time_utc));
    if (!Number.isFinite(expiry) || expiry <= Date.now()) return reply("expired");
    const recoveryHref = committedCardRecoveryHref({ ...binding, bookingId: row.id });
    return recoveryHref ? reply("found", 200, recoveryHref) : reply("unavailable", 503);
  } catch { return reply("unavailable", 503); }
}
