/**
 * No-show card recovery — Phase 1 (gentle follow-up nudge).
 *
 * A FUTURE booking that was asked for a card-on-file at booking time but never
 * left one gets ONE friendly follow-up "secure your spot — add a card" message
 * (reuses sendOnlineSaveCardLink → wrapper-guarded SMS + email). It NEVER
 * cancels anything — a held slot is recovered by getting the card, not by
 * punishing the customer.
 *
 * SAFETY:
 *  - Gated OFF by default (NOSHOW_CARD_NUDGE_ENABLED). While off this is a no-op,
 *    so deploying is harmless until deliberately enabled.
 *  - Grandfathered: migration 20260705020000 stamped every pre-existing
 *    card-required booking as already-nudged, so the current backlog (incl. the
 *    confirmed appointments customers already made) is NEVER touched — only
 *    bookings created after go-live are eligible.
 *  - Atomic claim (stamp reminder_sent_at before sending) → overlapping runs
 *    can't double-text and each booking is nudged at most once.
 *  - Per-run cap → no thundering herd on activation.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { sendOnlineSaveCardLink } from "@/shared/booking/sendOnlineSaveCardLink";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Give the at-booking first-touch save-card text time to work before nudging. */
const GRACE_HOURS = 3;
/** Anti-blast: cap nudges per run. */
const MAX_PER_RUN = 25;

export async function GET(req: NextRequest) {
  const secret = req.headers.get("authorization")?.replace("Bearer ", "");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Off by default — deploying is a no-op until this is deliberately enabled.
  if (process.env.NOSHOW_CARD_NUDGE_ENABLED !== "1") {
    return NextResponse.json({ ok: true, skipped: "disabled" });
  }

  const supabase = createServiceRoleClient();
  const nowIso = new Date().toISOString();
  const graceIso = new Date(Date.now() - GRACE_HOURS * 60 * 60 * 1000).toISOString();

  // Eligible: still needs a card, still a FUTURE appointment, booked long enough
  // ago that the first-touch text had its chance, and not yet nudged. The
  // `reminder_sent_at is null` filter + the grandfather backfill mean the
  // existing backlog can never appear here.
  const { data: rows, error } = await supabase
    .from("bookings" as never)
    .select("id")
    .eq("noshow_card_required", true)
    .is("noshow_card_id", null)
    .in("status", ["confirmed", "pending"])
    .gt("start_time_utc", nowIso)
    .lt("created_at", graceIso)
    .is("noshow_card_reminder_sent_at", null)
    .order("created_at", { ascending: true })
    .limit(MAX_PER_RUN);

  if (error) {
    console.error("[noshow-card-nudge] query failed", error);
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }

  let nudged = 0;
  for (const r of (rows ?? []) as Array<{ id: string }>) {
    // Claim atomically (stamp = nudged) so overlapping runs never double-text
    // and each booking is nudged at most once. If the claim loses, skip.
    const { data: claimed } = await supabase
      .from("bookings" as never)
      .update({ noshow_card_reminder_sent_at: new Date().toISOString() } as never)
      .eq("id", r.id)
      .is("noshow_card_reminder_sent_at", null)
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    try {
      // Re-checks card_required && no card internally, so a card added between
      // our read and here means it safely no-ops. Wrapper-guarded (kill-switch).
      await sendOnlineSaveCardLink(r.id);
      nudged += 1;
    } catch (e) {
      console.error("[noshow-card-nudge] send failed", r.id, e);
    }
  }

  return NextResponse.json({ ok: true, nudged });
}
