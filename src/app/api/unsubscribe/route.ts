import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { unsubscribeValid } from "@/shared/lib/emailCompliance";

export const runtime = "nodejs";

/** Record the opt-out for an HMAC-verified email (idempotent). */
async function suppress(email: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  if (!e) return false;
  const { error } = await createServiceRoleClient()
    .from("client_email_optouts" as never)
    .upsert({ email: e } as never, { onConflict: "email" });
  return !error;
}

function params(req: Request) {
  const u = new URL(req.url);
  return { email: (u.searchParams.get("e") ?? "").trim(), sig: (u.searchParams.get("sig") ?? "").trim() };
}

/** RFC 8058 one-click POST target (Gmail/Apple "Unsubscribe" button). */
export async function POST(req: Request) {
  const { email, sig } = params(req);
  if (!unsubscribeValid(email, sig)) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const suppressed = await suppress(email);
  if (!suppressed) {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}

/** Some clients fire GET on the List-Unsubscribe URL — honour it too. */
export async function GET(req: Request) {
  const { email, sig } = params(req);
  if (!unsubscribeValid(email, sig)) {
    return new NextResponse("Invalid unsubscribe link.", { status: 400 });
  }
  const suppressed = await suppress(email);
  if (!suppressed) {
    return new NextResponse("Could not unsubscribe right now. Please try again.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new NextResponse("You've been unsubscribed. / Bạn đã ngừng nhận email.", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
