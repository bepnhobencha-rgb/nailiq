import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export async function POST(req: Request) {
  let body: { token?: string };
  try {
    body = (await req.json()) as { token?: string };
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_body" }, { status: 400 });
  }

  const token = (body.token ?? "").trim();
  if (!token) {
    return NextResponse.json({ ok: false, code: "missing_token" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc("cancel_booking_as_customer" as never, {
    p_token_id: token,
  });

  if (error) {
    console.error("[cancel-action] RPC error", error);
    return NextResponse.json({ ok: false, code: "server_error" }, { status: 500 });
  }

  const rows = Array.isArray(data) ? data : [];
  const row = rows[0] as { ok?: boolean; code?: string } | undefined;

  if (!row?.ok) {
    return NextResponse.json({ ok: false, code: row?.code ?? "unknown" }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
