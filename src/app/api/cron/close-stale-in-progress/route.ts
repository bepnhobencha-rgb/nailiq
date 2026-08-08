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
import { requireCronAuthorization } from "@/shared/security/cronAuthorization";
import { runTrackedCron } from "@/shared/security/cronRunHistory";
import { SESSION_TTL_SECONDS } from "@/shared/voiceai/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 55;

/** Long enough that no real service is still running, short enough that the
 *  badge clears the next morning rather than staying red for a week. */
const STALE_AFTER_HOURS = 12;
const BATCH_LIMIT = 200;
const VOICE_SESSION_GRACE_MINUTES = 5;

export async function GET(req: NextRequest) {
  const authorizationError = requireCronAuthorization(req);
  if (authorizationError) return authorizationError;
  return runTrackedCron("close_stale_in_progress", async () => {

  const supabase = createServiceRoleClient();
  const cutoff = new Date(
    Date.now() - STALE_AFTER_HOURS * 60 * 60 * 1000,
  ).toISOString();

  const { data: stale, error: findErr } = await supabase
    .from("bookings")
    .select("id, salon_id, start_time_utc, end_time_utc")
    .eq("status", "in_progress")
    .lt("end_time_utc", cutoff)
    .limit(BATCH_LIMIT);

  if (findErr) {
    console.error("[close-stale-in-progress] find failed", findErr);
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }

  const rows = stale ?? [];
  const ids = rows.map((r) => (r as { id: string }).id);
  if (ids.length > 0) {
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
  }

  // A Realtime key cannot outlive SESSION_TTL_SECONDS. If the browser closes
  // before its keepalive request reaches us, the session is interrupted rather
  // than still running. Re-asserting `active` in this atomic update prevents a
  // successful finalizer that wins the race from being overwritten.
  const voiceCutoff = new Date(
    Date.now() -
      (SESSION_TTL_SECONDS + VOICE_SESSION_GRACE_MINUTES * 60) * 1_000,
  ).toISOString();
  const { data: abandonedVoice, error: voiceErr } = await supabase
    .from("voice_ai_sessions")
    .update({ status: "abandoned" } as never)
    .eq("status", "active")
    .lt("started_at", voiceCutoff)
    .select("id");

  if (voiceErr) {
    console.error("[close-stale-in-progress] voice cleanup failed", voiceErr);
    return NextResponse.json(
      { error: "voice_cleanup_failed" },
      { status: 500 },
    );
  }

  const voiceAbandoned = abandonedVoice?.length ?? 0;
  if (voiceAbandoned > 0) {
    console.warn(
      `[close-stale-in-progress] marked ${voiceAbandoned} expired voice session(s) abandoned`,
    );
  }

    return NextResponse.json({
      ok: true,
      closed: ids.length,
      voice_abandoned: voiceAbandoned,
    });
  });
}
