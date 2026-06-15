import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Customer-facing "what card do you have on file for me" lookup, gated by the
 * same self-serve reminder token used for reschedule/cancel (the token is the
 * possession factor — it arrives only in the customer's confirmation email).
 * Returns display-only card fields (brand + last4) — never the PAN.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = (url.searchParams.get("token") ?? "").trim();
  if (!token) return NextResponse.json({ ok: false, code: "missing_token" }, { status: 400 });

  const supabase = createServiceRoleClient();
  const { data: tokenRow } = await supabase
    .from("booking_reminder_tokens" as never)
    .select("booking_id, expires_at")
    .eq("id", token)
    .maybeSingle();
  const tr = tokenRow as { booking_id: string; expires_at: string } | null;
  if (!tr) return NextResponse.json({ ok: false, code: "invalid_token" }, { status: 404 });
  if (Date.parse(tr.expires_at) < Date.now()) {
    return NextResponse.json({ ok: false, code: "expired_token" }, { status: 410 });
  }

  const { data: bRow } = await supabase
    .from("bookings" as never)
    .select(
      "salon_id, noshow_card_id, noshow_card_last4, noshow_card_brand, noshow_fee_cents, noshow_charge_status",
    )
    .eq("id", tr.booking_id)
    .maybeSingle();
  const b = bRow as
    | {
        salon_id: string;
        noshow_card_id: string | null;
        noshow_card_last4: string | null;
        noshow_card_brand: string | null;
        noshow_fee_cents: number | null;
        noshow_charge_status: string | null;
      }
    | null;
  if (!b) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });

  const { data: sRow } = await supabase
    .from("salons" as never)
    .select("name, currency_code")
    .eq("id", b.salon_id)
    .maybeSingle();
  const s = sRow as { name: string | null; currency_code: string | null } | null;
  const currency = String(s?.currency_code || "USD").trim().toUpperCase() || "USD";
  const feeCents = b.noshow_fee_cents ?? 0;

  return NextResponse.json({
    ok: true,
    salonName: s?.name ?? "",
    hasCard: Boolean(b.noshow_card_id),
    brand: b.noshow_card_brand ?? "",
    last4: b.noshow_card_last4 ?? "",
    feeLabel: `${(feeCents / 100).toFixed(2)} ${currency}`,
    status: b.noshow_charge_status ?? "",
  });
}
