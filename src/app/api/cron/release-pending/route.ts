/**
 * Releases pending bookings that haven't verified within 15 minutes.
 * Frees the soft_hold so other customers can grab the slot.
 * Called every 5 minutes by Vercel Cron.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const secret = req.headers.get("authorization")?.replace("Bearer ", "");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  // Cancel pending bookings older than 15 min with no verification
  const { data, error } = await supabase
    .from("bookings")
    .update({ status: "cancelled" } as never)
    .eq("status", "pending")
    .is("verification_method", null)
    .lt("created_at", cutoff)
    .select("id, salon_id");

  if (error) {
    console.error("[release-pending] error", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const released = data?.length ?? 0;
  if (released > 0) {
    console.log(`[release-pending] cancelled ${released} unverified pending bookings`);
  }

  return NextResponse.json({ ok: true, released });
}
