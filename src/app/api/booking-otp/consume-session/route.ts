import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

// Internal endpoint: marks a phone_otp_session as consumed so it cannot be reused.
// Called fire-and-forget from submitPublicBooking (browser) after booking is committed.
export async function POST(req: Request) {
  let body: { sessionId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const sessionId = (body.sessionId ?? "").trim();
  if (!sessionId) {
    return NextResponse.json({ error: "missing_session_id" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  await supabase
    .from("phone_otp_sessions")
    .update({ consumed_at: new Date().toISOString() } as never)
    .eq("id", sessionId)
    .is("consumed_at", null);

  return NextResponse.json({ ok: true });
}
