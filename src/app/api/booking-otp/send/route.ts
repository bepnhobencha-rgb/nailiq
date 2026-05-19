import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { sendVerification } from "@/shared/lib/twilioVerify";

export async function POST(req: Request) {
  let body: { phone?: string; shopSlug?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const phone = (body.phone ?? "").trim();
  const shopSlug = (body.shopSlug ?? "").trim();
  if (!phone || !shopSlug) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const phoneOk = validateGuestPhone(phone);
  if (!phoneOk.ok) {
    return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data: salon } = await supabase
    .from("salons")
    .select("id, phone_otp_enabled")
    .eq("slug", shopSlug)
    .maybeSingle();

  if (!salon || !(salon as unknown as { phone_otp_enabled: boolean }).phone_otp_enabled) {
    return NextResponse.json({ error: "otp_not_enabled" }, { status: 400 });
  }

  const e164 = `+${phoneOk.digits}`;
  const result = await sendVerification(e164);

  if (!result.ok) {
    console.error("[booking-otp/send] sendVerification failed", result.error);
    return NextResponse.json(
      { error: result.error ?? "send_failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
