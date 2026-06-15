import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { noShowCardDecision } from "@/shared/integrations/square/noshow";

/**
 * Context for the desk-sent "save a card to hold your spot" page
 * (`/booking/save-card`). Gated by the same self-serve reminder token as the
 * manage-card / reschedule links — the token is the possession factor, arriving
 * only in the customer's SMS. Returns the booking id (so the proven
 * NoShowCardCapture component can fetch the provider config + save the card,
 * exactly as it does in the online booking flow) plus salon display fields.
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
    .select("id, salon_id, status, noshow_card_id, service_id, client_phone")
    .eq("id", tr.booking_id)
    .maybeSingle();
  const b = bRow as
    | {
        id: string;
        salon_id: string;
        status: string;
        noshow_card_id: string | null;
        service_id: string | null;
        client_phone: string | null;
      }
    | null;
  if (!b) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });

  const { data: sRow } = await supabase
    .from("salons" as never)
    .select("name, currency_code")
    .eq("id", b.salon_id)
    .maybeSingle();
  const s = sRow as { name: string | null; currency_code: string | null } | null;

  // Whether THIS customer actually needs a card — use the SAME post-booking
  // decision the capture component uses (noShowCardDecision), so the page and
  // the form never diverge. (resolveNoShowCardRequirement is the PRE-booking
  // gate; it would count the current booking as prior history and wrongly read
  // the customer as "returning", hiding the form the component shows.)
  const decision = await noShowCardDecision(b.id);
  const cardRequired = decision.required;

  return NextResponse.json({
    ok: true,
    bookingId: b.id,
    salonName: s?.name ?? "",
    currencyCode: String(s?.currency_code || "USD").trim().toUpperCase() || "USD",
    alreadySaved: Boolean(b.noshow_card_id),
    cancelled: b.status === "cancelled",
    cardRequired,
  });
}
