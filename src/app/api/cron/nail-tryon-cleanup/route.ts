import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { recordNailTryOnEvent } from "@/shared/nailTryOn/telemetry";
import { requireCronAuthorization } from "@/shared/security/cronAuthorization";
import { runTrackedCron } from "@/shared/security/cronRunHistory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 55;

type QueueRow = { id: number; tryon_session_id: string; object_path: string; attempts: number };

export async function GET(request: Request) {
  const authorizationError = requireCronAuthorization(request);
  if (authorizationError) return authorizationError;
  return runTrackedCron("nail_tryon_cleanup", async () => {
    const db = createServiceRoleClient();
    const { data: queuedData, error: queueError } = await db.rpc(
      "queue_expired_nail_tryon_sessions" as never,
      { p_limit: 200 } as never,
    );
    if (queueError) {
      return NextResponse.json({ error: "queue_failed" }, { status: 500 });
    }
    const queued = typeof queuedData === "number" ? queuedData : 0;
    const { data, error } = await db.from("nail_tryon_cleanup_queue" as never)
      .select("id, tryon_session_id, object_path, attempts").is("processed_at", null)
      .lte("available_at", new Date().toISOString()).order("id").limit(200);
    if (error) {
      return NextResponse.json({ error: "queue_failed" }, { status: 500 });
    }

    const rows = (data || []) as unknown as QueueRow[];
    let deleted = 0;
    let pendingFailures = 0;
    for (const row of rows) {
      const { error: removeError } = await db.storage.from("nail-tryon")
        .remove([row.object_path]);
      if (removeError) {
        pendingFailures += 1;
        await db.from("nail_tryon_cleanup_queue" as never).update({
          attempts: row.attempts + 1,
          last_error: removeError.message,
          available_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        } as never).eq("id", row.id);
        continue;
      }
      await db.from("nail_tryon_cleanup_queue" as never).update({
        processed_at: new Date().toISOString(),
        last_error: null,
      } as never).eq("id", row.id);
      deleted += 1;
    }

    const sessionIds = [...new Set(rows.map((row) => row.tryon_session_id))];
    let completedSessions = 0;
    for (const sessionId of sessionIds) {
      const { count, error: pendingError } = await db
        .from("nail_tryon_cleanup_queue" as never)
        .select("id", { count: "exact", head: true })
        .eq("tryon_session_id", sessionId)
        .is("processed_at", null);
      if (pendingError || (count ?? 0) > 0) continue;

      const { data: raw } = await db.from("nail_tryon_sessions" as never)
        .select("salon_id").eq("id", sessionId).maybeSingle();
      const session = raw as unknown as { salon_id: string } | null;
      if (!session) continue;
      await recordNailTryOnEvent({
        salonId: session.salon_id,
        sessionId,
        event: "expired_deleted",
      });
      completedSessions += 1;
    }

    return NextResponse.json({
      ok: true,
      queued,
      inspected: rows.length,
      deleted,
      pendingFailures,
      completedSessions,
    });
  });
}
