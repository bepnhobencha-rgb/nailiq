import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";
import { consumePublicRequestRateLimit } from "@/shared/security/publicServerActionRateLimit";

export const dynamic = "force-dynamic";

/**
 * POST /api/vouchers/validate
 * Body: { salon_id, code, client_phone, service_id?, price_cents }
 *
 * Validates a voucher code at checkout. Server-side only — client cannot
 * override the discount amount. Returns calculated discount.
 */
export async function POST(req: Request) {
  const ipRate = await consumePublicRequestRateLimit({
    request: req,
    scope: "voucher-validate",
    ipLimits: [[30, 60], [150, 3_600]],
  });
  if (ipRate !== "allowed") {
    return NextResponse.json(
      { ok: false, error: ipRate === "limited" ? "rate_limited" : "temporarily_unavailable" },
      { status: ipRate === "limited" ? 429 : 503 },
    );
  }
  const { salon_id, code, client_phone, price_cents } = await req
    .json()
    .catch(() => ({}));

  if (!salon_id || !code || !client_phone || typeof price_cents !== "number") {
    return NextResponse.json(
      { ok: false, error: "missing_fields" },
      { status: 400 }
    );
  }

  const identityRate = await consumePublicRequestRateLimit({
    request: req,
    scope: "voucher-validate-identity",
    identity: [salon_id, code, toCanonicalPhone(client_phone)],
    ipLimits: [],
    identityLimits: [[10, 300], [40, 3_600]],
  });
  if (identityRate !== "allowed") {
    return NextResponse.json(
      { ok: false, error: identityRate === "limited" ? "rate_limited" : "temporarily_unavailable" },
      { status: identityRate === "limited" ? 429 : 503 },
    );
  }

  const db = createServiceRoleClient();

  const { data: voucher, error } = await db
    .from("vouchers")
    .select("*")
    .eq("salon_id", salon_id)
    .eq("code", code.toUpperCase())
    .is("revoked_at", null)
    .lte("valid_from", new Date().toISOString())
    .gte("expires_at", new Date().toISOString())
    .single();

  if (error || !voucher) {
    return NextResponse.json({ ok: false, error: "invalid_code" }, { status: 422 });
  }

  // Check uses
  if (voucher.used_count >= voucher.max_uses) {
    return NextResponse.json({ ok: false, error: "voucher_exhausted" }, { status: 422 });
  }

  // For personal vouchers (birthday, milestone, welcome_back, referral), verify
  // the phone. Canonicalise BOTH sides — the voucher stores a canonical digits
  // phone (e.g. "16045551234") but the customer may type any format at checkout
  // ("604-555-1234", "(604) 555-1234"); a raw compare wrongly rejected them.
  if (
    voucher.client_phone &&
    toCanonicalPhone(voucher.client_phone) !== toCanonicalPhone(client_phone)
  ) {
    return NextResponse.json({ ok: false, error: "voucher_not_yours" }, { status: 422 });
  }

  // Min spend check
  if (voucher.min_spend_cents && price_cents < voucher.min_spend_cents) {
    return NextResponse.json({
      ok: false,
      error: "below_min_spend",
      min_spend_cents: voucher.min_spend_cents,
    }, { status: 422 });
  }

  // Calculate discount server-side
  let discountCents = 0;
  if (voucher.percent_off) {
    discountCents = Math.floor((price_cents * voucher.percent_off) / 100);
  } else if (voucher.amount_off_cents) {
    discountCents = Math.min(voucher.amount_off_cents, price_cents);
  }

  const finalCents = Math.max(0, price_cents - discountCents);

  return NextResponse.json({
    ok: true,
    voucher_id: voucher.id,
    code: voucher.code,
    kind: voucher.kind,
    discount_cents: discountCents,
    final_price_cents: finalCents,
    percent_off: voucher.percent_off,
    amount_off_cents: voucher.amount_off_cents,
  });
}
