import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export async function POST(req: Request) {
  const { salon_id } = await req.json().catch(() => ({}));
  if (!salon_id) return NextResponse.json({ ok: false }, { status: 400 });

  const db = createServiceRoleClient();
  await db.rpc("increment_trend_click" as never, { p_salon_id: salon_id });

  return NextResponse.json({ ok: true });
}
