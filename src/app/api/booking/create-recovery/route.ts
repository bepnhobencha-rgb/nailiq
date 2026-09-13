import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { clientIp, durableRateLimitKey, isOverRateLimit } from "@/shared/lib/inAppRateLimit";
import { readJsonObjectWithLimit } from "@/shared/security/readJsonObjectWithLimit";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";
import { parsePendingBookingCreate } from "@/shared/booking/pendingBookingCreate";
import { committedCardRecoveryHref } from "@/shared/booking/committedCardRecovery";

const headers = { "Cache-Control": "private, no-store, max-age=0", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" };
const reply = (status: string, code = 200, recoveryHref?: string) => NextResponse.json({ ok: code === 200, status, ...(recoveryHref ? { recoveryHref } : {}) }, { status: code, headers });

/** Read existing authority only. Never create, mint, reconcile a provider or send. */
export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return reply("forbidden", 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return reply("invalid_request", 400);
  const body = await readJsonObjectWithLimit(request, 1024);
  if (!body || Object.keys(body).some(key => !["kind", "salonId", "idempotencyKey", "pricingFingerprint"].includes(key))) return reply("invalid_request", 400);
  const binding = parsePendingBookingCreate(`#booking=${body.kind}.${body.salonId}.${body.idempotencyKey}.${body.pricingFingerprint}`);
  if (!binding) return reply("invalid_request", 400);
  try {
    if (await isOverRateLimit(durableRateLimitKey("create-recovery", clientIp(request), binding.salonId), 12, 300, { failureMode: "block" })) return reply("unavailable", 429);
    const db = createServiceRoleClient({ timeoutMs: 4000 });
    const { data, error } = await db.from("bookings")
      .select("id,schedule_model,created_at,start_time_utc,public_booking_request_fingerprint,public_booking_pricing_snapshot")
      .eq("salon_id", binding.salonId).eq("idempotency_key", binding.idempotencyKey)
      .eq("public_booking_pricing_fingerprint", binding.pricingFingerprint)
      .eq("schedule_model", binding.kind === "sequence" ? "segments_v1" : "single").eq("status", "confirmed")
      .is("deleted_at", null).is("recovered_from_booking_id", null).is("group_id", null).limit(2);
    if (error) return reply("unavailable", 503);
    // A missing read is not proof that the original transaction failed.
    if (!data?.length) return reply("pending");
    if (data.length !== 1) return reply("unavailable", 503);
    const row = data[0];
    const snapshot = row.public_booking_pricing_snapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || snapshot.pricing_fingerprint !== binding.pricingFingerprint ||
      !/^[0-9a-f]{64}$/.test(row.public_booking_request_fingerprint ?? "")) return reply("unavailable", 503);
    if (binding.kind === "sequence" && (snapshot.booking_id !== row.id || snapshot.salon_id !== binding.salonId ||
      snapshot.request_id !== binding.idempotencyKey || snapshot.schedule_model !== "segments_v1" ||
      !Array.isArray(snapshot.segment_ids) || !snapshot.segment_ids.length || new Set(snapshot.segment_ids).size !== snapshot.segment_ids.length)) return reply("unavailable", 503);
    const expiry = Math.min(Date.parse(row.created_at) + 30 * 60_000, Date.parse(row.start_time_utc));
    if (!Number.isFinite(expiry) || expiry <= Date.now()) return reply("expired");
    const recoveryHref = committedCardRecoveryHref({ ...binding, bookingId: row.id });
    return recoveryHref ? reply("found", 200, recoveryHref) : reply("unavailable", 503);
  } catch { return reply("unavailable", 503); }
}
