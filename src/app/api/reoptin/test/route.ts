import { NextResponse } from "next/server";
import { createClient } from "@/shared/lib/supabase/server";
import { getSuperAdminRole } from "@/shared/lib/superadmin";
import { runReoptinBatch } from "@/shared/reoptin/reoptinCampaign";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/reoptin/test — browser-friendly re-opt-in trigger, authenticated by
 * the caller's SUPERADMIN session (no CRON_SECRET needed, since sensitive env
 * vars can't be read back from the dashboard). Just open the URL while logged
 * in as superadmin.
 *
 * Query:
 *   ?salon=hilite-anaheim         (default hilite-anaheim)
 *   ?to=you@example.com           -> send ONE sample email (copy review)
 *   ?dry=1[&limit=200]            -> dry-run, count the target list, send nothing
 *   ?send=1[&limit=200]           -> REAL send to the capped list (explicit)
 *
 * The batch is idempotent per (salon, client), so an accidental double-open
 * never double-sends.
 */
export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !(await getSuperAdminRole(user.id))) {
    return NextResponse.json(
      { ok: false, error: "unauthorized — open this while logged in as superadmin" },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const salon = url.searchParams.get("salon") ?? "hilite-anaheim";
  const to = url.searchParams.get("to");
  const send = url.searchParams.get("send") === "1";
  const limit = Number(url.searchParams.get("limit") ?? "200") || 200;

  let summary;
  if (to) {
    summary = await runReoptinBatch(salon, { testTo: to });
  } else if (send) {
    summary = await runReoptinBatch(salon, { limit });
  } else {
    // Default is safe: dry-run count. A real send needs an explicit ?send=1.
    summary = await runReoptinBatch(salon, { dryRun: true, limit });
  }

  return NextResponse.json({ ok: true, summary });
}
