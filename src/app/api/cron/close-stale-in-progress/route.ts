/**
 * Close out bookings staff started but never finished.
 *
 * A booking goes `in_progress` when the desk taps "start" and only leaves that
 * state when someone taps "complete". When the salon closes mid-service — or
 * the tab is simply shut — the row stays `in_progress` forever. That silently
 * corrupts revenue and no-show reporting, and it pinned the sidebar's overdue
 * badge permanently red (Hi-Lite Studio carried one from 2026-07-10 for ten
 * days), which teaches staff that the red badge means nothing.
 *
 * A service that ended more than STALE_AFTER_HOURS ago is not still running, so
 * it is marked `completed` — the customer was on the chair and was served; the
 * desk just never tapped the button. `no_show` would be wrong: the visit did
 * happen. Anything genuinely a no-show is marked as such by the desk before it
 * ever reaches `in_progress`.
 *
 * Deliberately conservative: only touches rows whose end time is already well
 * in the past, caps the batch, and records what it closed so an operator can
 * see the sweep rather than discover silently-rewritten history.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 55;

/** Long enough that no real service is still running, short enough that the
 *  badge clears the next morning rather than staying red for a week. */
const STALE_AFTER_HOURS = 12;
const BATCH_LIMIT = 200;

export async function GET(req: NextRequest) {
  const secret = req.headers.get("authorization")?.replace("Bearer ", "");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const cutoff = new Date(
    Date.now() - STALE_AFTER_HOURS * 60 * 60 * 1000,
  ).toISOString();

  const { data: stale, error: findErr } = await supabase
    .from("bookings")
    .select("id, salon_id, client_name, start_time_utc, end_time_utc")
    .eq("status", "in_progress")
    .lt("end_time_utc", cutoff)
    .limit(BATCH_LIMIT);

  if (findErr) {
    console.error("[close-stale-in-progress] find failed", findErr);
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }

  const rows = stale ?? [];
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, closed: 0 });
  }

  const ids = rows.map((r) => (r as { id: string }).id);
  // Re-assert the status in the WHERE clause: if the desk closed one of these
  // between the read and this write, leave their value alone.
  const { error: updErr } = await supabase
    .from("bookings")
    .update({ status: "completed" } as never)
    .in("id", ids)
    .eq("status", "in_progress");

  if (updErr) {
    console.error("[close-stale-in-progress] update failed", updErr);
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }

  console.warn(
    `[close-stale-in-progress] auto-closed ${ids.length} abandoned booking(s)`,
    rows.map((r) => {
      const b = r as { id: string; salon_id: string; end_time_utc: string };
      return { id: b.id, salonId: b.salon_id, endedAt: b.end_time_utc };
    }),
  );

  return NextResponse.json({ ok: true, closed: ids.length });
}
