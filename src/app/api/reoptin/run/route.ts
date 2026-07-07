import { NextResponse } from "next/server";
import { runReoptinBatch } from "@/shared/reoptin/reoptinCampaign";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/reoptin/run — operator-triggered re-opt-in campaign send.
 * Secured by CRON_SECRET (same scheme as the other cron/admin routes).
 *
 * Body:
 *   { salon_slug: string, limit?: number, dryRun?: boolean, testTo?: string }
 *
 *   testTo  → one sample email to that address (copy review, no DB writes)
 *   dryRun  → walk the real target list, send nothing (returns counts)
 *   neither → real send, capped by limit (default 200), highest-spend first
 */
export async function POST(req: Request) {
  const secret = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    salon_slug?: string;
    limit?: number;
    dryRun?: boolean;
    testTo?: string;
  };

  if (!body.salon_slug) {
    return NextResponse.json({ ok: false, error: "missing_salon_slug" }, { status: 400 });
  }

  const summary = await runReoptinBatch(body.salon_slug, {
    limit: body.limit,
    dryRun: body.dryRun,
    testTo: body.testTo,
  });

  return NextResponse.json({ ok: true, summary });
}
