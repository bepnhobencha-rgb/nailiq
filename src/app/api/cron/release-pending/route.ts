/**
 * Releases pending bookings that haven't verified within 15 minutes.
 * Frees the soft_hold so other customers can grab the slot.
 * Called every 5 minutes by Vercel Cron.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const secret = req.headers.get("authorization")?.replace("Bearer ", "");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  // Cancel pending bookings older than 15 min with no verification
  const { data, error } = await supabase
    .from("bookings")
    .update({ status: "cancelled" } as never)
    .eq("status", "pending")
    .is("verification_method", null)
    .lt("created_at", cutoff)
    .select("id, salon_id");

  if (error) {
    console.error("[release-pending] error", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const released = data?.length ?? 0;
  if (released > 0) {
    console.log(`[release-pending] cancelled ${released} unverified pending bookings`);
  }

  // Hold-until-card: release a FUTURE booking that was required to leave a card
  // (new / high-risk) but never did, once the grace window passes — so the slot
  // isn't held by a customer who didn't commit a card. 30-min grace gives the
  // customer time to finish on the confirmation screen.
  const cardCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();
  const { data: cardData, error: cardErr } = await supabase
    .from("bookings")
    .update({ status: "cancelled" } as never)
    .eq("noshow_card_required", true)
    .is("noshow_card_id", null)
    .in("status", ["confirmed", "pending"])
    .lt("created_at", cardCutoff)
    .gt("start_time_utc", nowIso)
    .select("id");
  if (cardErr) {
    console.error("[release-pending] card-release error", cardErr);
  }
  const cardReleased = cardData?.length ?? 0;
  if (cardReleased > 0) {
    console.log(`[release-pending] cancelled ${cardReleased} no-card bookings`);
  }

  // Pay-deposit-to-confirm: release a FUTURE booking whose slot was held pending a
  // deposit that was never paid, once the salon's grace window passes (measured
  // from when the link was created, not booking creation). reconcileDeposits
  // clears deposit_hold the moment payment lands, so a paid booking is never
  // caught here. The window is per-salon (salons.deposit_hold_grace_minutes,
  // admin-set, default 30) — so we filter in JS rather than one fixed cutoff.
  let depositReleased = 0;
  const { data: depCands } = await supabase
    .from("bookings")
    .select("id, deposit_requested_at, salon_id")
    .eq("deposit_hold", true)
    .eq("deposit_status", "required")
    .in("status", ["confirmed", "pending"])
    .gt("start_time_utc", nowIso);
  const depRows = (depCands ?? []) as Array<{ id: string; deposit_requested_at: string | null; salon_id: string }>;
  if (depRows.length > 0) {
    const salonIds = [...new Set(depRows.map((r) => r.salon_id))];
    const { data: salonRows } = await supabase
      .from("salons")
      .select("id, deposit_hold_grace_minutes")
      .in("id", salonIds);
    const graceMap = new Map(
      ((salonRows ?? []) as Array<{ id: string; deposit_hold_grace_minutes: number | null }>).map(
        (s) => [s.id, s.deposit_hold_grace_minutes ?? 30],
      ),
    );
    const now = Date.now();
    const toCancel = depRows
      .filter((r) => {
        if (!r.deposit_requested_at) return false;
        const graceMs = (graceMap.get(r.salon_id) ?? 30) * 60 * 1000;
        return Date.parse(r.deposit_requested_at) < now - graceMs;
      })
      .map((r) => r.id);
    if (toCancel.length > 0) {
      const { error: depErr } = await supabase
        .from("bookings")
        .update({ status: "cancelled", deposit_hold: false } as never)
        .in("id", toCancel);
      if (depErr) console.error("[release-pending] deposit-release error", depErr);
      else depositReleased = toCancel.length;
    }
  }
  if (depositReleased > 0) {
    console.log(`[release-pending] cancelled ${depositReleased} unpaid-deposit bookings`);
  }

  return NextResponse.json({ ok: true, released, cardReleased, depositReleased });
}
