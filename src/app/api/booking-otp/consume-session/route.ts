import { NextResponse } from "next/server";
import { z } from "zod";

import { readJsonObjectWithLimit } from "@/shared/security/readJsonObjectWithLimit";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

// Public capability endpoint: the unguessable session UUID permits consumption only.
// Called fire-and-forget from submitPublicBooking (browser) after booking is committed.
const bodySchema = z.object({
  sessionId: z.string().nullish(),
});

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await readJsonObjectWithLimit(req, 2048));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const body = parsed.data;

  const sessionId = (body.sessionId ?? "").trim();
  if (!sessionId) {
    return NextResponse.json({ error: "missing_session_id" }, { status: 400 });
  }

  if (!z.uuid().safeParse(sessionId).success) {
    return NextResponse.json({ error: "invalid_session_id" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("phone_otp_sessions")
    .update({ consumed_at: new Date().toISOString() } as never)
    .eq("id", sessionId)
    .is("consumed_at", null);

  if (error) {
    return NextResponse.json({ error: "session_unavailable" }, { status: 503, headers: { "Retry-After": "30" } });
  }

  return NextResponse.json({ ok: true });
}
