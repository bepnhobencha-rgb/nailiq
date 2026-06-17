import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { resolvePaymentProvider } from "@/shared/integrations/payments";

/**
 * Customer-initiated removal of a saved no-show card, gated by the self-serve
 * reminder token. Disables the card at the provider so it can NEVER be charged
 * again (the cancel-the-stored-credential right the card networks require), then
 * clears the card reference on the booking. Cannot remove after a charge has
 * already been taken.
 */
export async function POST(req: Request) {
  let body: { token?: string };
  try {
    body = (await req.json()) as { token?: string };
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_body" }, { status: 400 });
  }
  const token = (body.token ?? "").trim();
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
    .select("salon_id, noshow_card_id, noshow_customer_id, noshow_charge_status")
    .eq("id", tr.booking_id)
    .maybeSingle();
  const b = bRow as
    | { salon_id: string; noshow_card_id: string | null; noshow_customer_id: string | null; noshow_charge_status: string | null }
    | null;
  if (!b) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  if (!b.noshow_card_id) return NextResponse.json({ ok: true, code: "already_removed" });
  if (b.noshow_charge_status === "charged") {
    return NextResponse.json({ ok: false, code: "already_charged" }, { status: 409 });
  }

  const provider = await resolvePaymentProvider(b.salon_id);
  if (!provider) return NextResponse.json({ ok: false, code: "provider_unavailable" }, { status: 500 });

  try {
    await provider.removeSavedCard({
      cardId: b.noshow_card_id,
      customerId: b.noshow_customer_id ?? "",
    });
  } catch (e) {
    console.error("[remove-card] provider remove failed", e);
    return NextResponse.json({ ok: false, code: "remove_failed" }, { status: 502 });
  }

  // Clear the chargeable reference; keep brand/last4 + consent_meta as history.
  await supabase
    .from("bookings" as never)
    .update({
      noshow_card_id: null,
      noshow_customer_id: null,
      noshow_charge_status: "removed_by_customer",
    } as never)
    .eq("id", tr.booking_id);

  return NextResponse.json({ ok: true });
}
