import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { sendVerification } from "@/shared/lib/twilioVerify";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";
import { createAndSendEmailOtp } from "@/shared/lib/emailOtp";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";

export async function POST(req: Request) {
  let body: { phone?: string; shopSlug?: string; channel?: string; email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const phone = (body.phone ?? "").trim();
  const shopSlug = (body.shopSlug ?? "").trim();
  const channel = body.channel === "email" ? "email" : "sms";
  const email = (body.email ?? "").trim().toLowerCase();
  if (!phone || !shopSlug) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const phoneOk = validateGuestPhone(phone);
  if (!phoneOk.ok) {
    return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
  }
  if (channel === "email" && !isValidEmailFormat(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data: salon } = await supabase
    .from("salons")
    .select("id, name, address, phone_otp_enabled, email_links_enabled")
    .eq("slug", shopSlug)
    .maybeSingle();

  const salonRow = salon as unknown as {
    id: string;
    name?: string | null;
    address?: string | null;
    phone_otp_enabled: boolean;
    email_links_enabled?: boolean | null;
  } | null;
  if (!salonRow || !salonRow.phone_otp_enabled) {
    return NextResponse.json({ error: "otp_not_enabled" }, { status: 400 });
  }

  // Demo/E2E mode: skip real sends, accept code 000000 in verify (both channels).
  if (isDemoOtpRuntime()) {
    return NextResponse.json({ ok: true });
  }

  // ── EMAIL channel (resilient fallback) ──────────────────────────────────
  if (channel === "email") {
    // Gated by the same per-salon email-channel master as the link emails.
    if (salonRow.email_links_enabled === false) {
      return NextResponse.json({ error: "email_channel_disabled" }, { status: 400 });
    }
    const result = await createAndSendEmailOtp({
      salonId: String(salonRow.id),
      phone: phoneOk.digits,
      email,
      salonName: salonRow.name ?? "NailIQ",
      salonAddress: salonRow.address ?? null,
    });
    if (!result.ok) {
      const status = result.error === "rate_limited" ? 429 : 500;
      return NextResponse.json({ error: result.error ?? "send_failed" }, { status });
    }
    return NextResponse.json({ ok: true });
  }

  // ── SMS channel (default) ───────────────────────────────────────────────
  const e164 = `+${phoneOk.digits}`;
  // Show the salon's own name in the OTP message instead of the generic Verify
  // Service name, so the customer recognizes who's texting them.
  const result = await sendVerification(e164, salonRow.name ?? undefined);

  if (!result.ok) {
    console.error("[booking-otp/send] sendVerification failed", result.error);
    return NextResponse.json(
      { error: result.error ?? "send_failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
