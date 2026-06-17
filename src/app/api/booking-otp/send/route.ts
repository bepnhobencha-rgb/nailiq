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

  // ── Server-side SMS send guard (authoritative) ──────────────────────────────
  // The client has a 60s resend cooldown + a per-phone auto-send guard, but those
  // are bypassable (direct API call, second tab, page reload). This DB-backed
  // guard is the real protection against duplicate Twilio Verify charges: at most
  // one SMS per phone per 30s, and 5 per 15 min. Runs in demo mode too so it is
  // E2E-testable. The email channel has its own limit inside createAndSendEmailOtp.
  if (channel === "sms") {
    const guard = await guardSmsSend(supabase, String(salonRow.id), phoneOk.digits);
    if (!guard.ok) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }
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

const SMS_MIN_GAP_MS = 30_000;          // ≥ 30s between SMS to the same phone
const SMS_WINDOW_MS  = 15 * 60 * 1000;  // 15-minute window
const SMS_WINDOW_MAX = 5;               // ≤ 5 SMS per window

/**
 * DB-backed SMS send throttle. Returns `{ ok: false }` when the phone was texted
 * < 30s ago for this salon, or has hit 5 sends in the last 15 minutes. On allow,
 * records the attempt in `otp_send_log` so the next call sees it. Fails OPEN on a
 * DB error — never block a real customer's OTP because the log table hiccuped.
 */
async function guardSmsSend(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonId: string,
  phoneDigits: string,
): Promise<{ ok: boolean }> {
  try {
    const since = new Date(Date.now() - SMS_WINDOW_MS).toISOString();
    const { data: rows } = await supabase
      .from("otp_send_log" as never)
      .select("created_at")
      .eq("salon_id", salonId)
      .eq("phone", phoneDigits)
      .eq("channel", "sms")
      .gte("created_at", since)
      .order("created_at", { ascending: false });

    const recent = (rows ?? []) as unknown as { created_at: string }[];
    if (recent.length >= SMS_WINDOW_MAX) return { ok: false };
    const newest = recent[0]?.created_at ? Date.parse(recent[0].created_at) : 0;
    if (newest && Date.now() - newest < SMS_MIN_GAP_MS) return { ok: false };

    await supabase
      .from("otp_send_log" as never)
      .insert({ salon_id: salonId, phone: phoneDigits, channel: "sms" } as never);
    return { ok: true };
  } catch {
    return { ok: true }; // fail open
  }
}
