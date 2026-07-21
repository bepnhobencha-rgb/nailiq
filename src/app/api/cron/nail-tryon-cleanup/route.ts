import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { recordNailTryOnEvent } from "@/shared/nailTryOn/telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 55;

type QueueRow = { id: number; tryon_session_id: string; object_path: string; attempts: number };

export async function GET(request: Request) {
  const secret = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = createServiceRoleClient();
  await db.rpc("queue_expired_nail_tryon_sessions" as never, { p_limit: 200 } as never);
  const { data, error } = await db.from("nail_tryon_cleanup_queue" as never)
    .select("id, tryon_session_id, object_path, attempts").is("processed_at", null)
    .lte("available_at", new Date().toISOString()).order("id").limit(200);
  if (error) return NextResponse.json({ error: "queue_failed" }, { status: 500 });

  const rows = (data || []) as unknown as QueueRow[];
  let deleted = 0;
  for (const row of rows) {
    const { error: removeError } = await db.storage.from("nail-tryon").remove([row.object_path]);
    if (removeError) {
      await db.from("nail_tryon_cleanup_queue" as never).update({ attempts: row.attempts + 1, last_error: removeError.message, available_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() } as never).eq("id", row.id);
      continue;
    }
    await db.from("nail_tryon_cleanup_queue" as never).update({ processed_at: new Date().toISOString(), last_error: null } as never).eq("id", row.id);
    deleted += 1;
  }
  const sessionIds = [...new Set(rows.map((row) => row.tryon_session_id))];
  for (const sessionId of sessionIds) {
    const { data: raw } = await db.from("nail_tryon_sessions" as never).select("salon_id").eq("id", sessionId).maybeSingle();
    const session = raw as unknown as { salon_id: string } | null;
    if (session) await recordNailTryOnEvent({ salonId: session.salon_id, sessionId, event: "expired_deleted" });
  }
  return NextResponse.json({ ok: true, queued: rows.length, deleted });
}
