import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export async function POST(req: Request) {
  const { session_id, outcome, added_revenue_cents } = await req.json().catch(() => ({}));
  if (!session_id || !outcome) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const db = createServiceRoleClient();
  await db
    .from("ai_upsell_log")
    .update({
      outcome,
      outcome_at: new Date().toISOString(),
      added_revenue_cents: added_revenue_cents ?? null,
    })
    .eq("session_id", session_id)
    .eq("outcome", "shown");

  return NextResponse.json({ ok: true });
}
