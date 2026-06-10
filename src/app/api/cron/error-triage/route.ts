// GET /api/cron/error-triage — runs the AI triage + alert pass over freshly
// captured errors. Picks open, not-yet-summarized errors, has Claude summarize +
// suggest a fix, then emails the operator about new error/fatal ones (once).
// CRON_SECRET-gated; registered in vercel.json.

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { triageError, sendErrorAlert } from "@/shared/observability/triageError";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const cronSecret = (process.env.CRON_SECRET ?? "").trim();
  if (cronSecret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("error_logs")
    .select("id, level, alerted_at")
    .eq("status", "open")
    .is("ai_summary", null)
    .order("last_seen_at", { ascending: false })
    .limit(15);
  if (error) {
    console.error("[cron/error-triage] load", error);
    return NextResponse.json({ ok: false, error: "load_failed" }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{ id: string; level: string; alerted_at: string | null }>;
  let triaged = 0;
  let alerted = 0;
  for (const r of rows) {
    const res = await triageError(r.id);
    if (res.ok) triaged++;
    // Alert on new error/fatal once (warnings are summarized but not emailed).
    if ((r.level === "error" || r.level === "fatal") && !r.alerted_at) {
      const sent = await sendErrorAlert(r.id);
      if (sent) {
        await db
          .from("error_logs")
          .update({ alerted_at: new Date().toISOString() } as never)
          .eq("id", r.id);
        alerted++;
      }
    }
  }

  return NextResponse.json({ ok: true, scanned: rows.length, triaged, alerted });
}
