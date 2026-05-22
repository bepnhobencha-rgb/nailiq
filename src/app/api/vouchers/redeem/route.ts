import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export const dynamic = "force-dynamic";

/**
 * POST /api/vouchers/redeem
 * Body: { voucher_id, salon_id, client_phone, booking_id, original_price_cents, discount_cents }
 *
 * Records redemption. Called after booking is created successfully.
 * Idempotent on (voucher_id, booking_id) — safe to call twice.
 */
export async function POST(req: Request) {
  const {
    voucher_id,
    salon_id,
    client_phone,
    booking_id,
    original_price_cents,
    discount_cents,
  } = await req.json().catch(() => ({}));

  if (!voucher_id || !salon_id || !client_phone || typeof discount_cents !== "number") {
    return NextResponse.json({ ok: false, error: "missing_fields" }, { status: 400 });
  }

  const db = createServiceRoleClient();

  // Re-validate voucher (server-side, never trust client)
  const { data: voucher } = await db
    .from("vouchers")
    .select("id, salon_id, used_count, max_uses, revoked_at, expires_at")
    .eq("id", voucher_id)
    .single();

  if (
    !voucher ||
    voucher.salon_id !== salon_id ||
    voucher.revoked_at ||
    voucher.used_count >= voucher.max_uses ||
    new Date(voucher.expires_at) < new Date()
  ) {
    return NextResponse.json({ ok: false, error: "voucher_invalid" }, { status: 422 });
  }

  const finalCents = Math.max(0, (original_price_cents ?? 0) - discount_cents);

  const { error: insertErr } = await db.from("voucher_redemptions").insert({
    voucher_id,
    salon_id,
    client_phone,
    booking_id: booking_id ?? null,
    original_price_cents: original_price_cents ?? null,
    discount_applied_cents: discount_cents,
    final_price_cents: finalCents,
  });

  if (insertErr) {
    // Unique constraint on (voucher_id, booking_id) means idempotent call
    if (insertErr.code === "23505") {
      return NextResponse.json({ ok: true, idempotent: true });
    }
    return NextResponse.json({ ok: false, error: insertErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, final_price_cents: finalCents });
}
