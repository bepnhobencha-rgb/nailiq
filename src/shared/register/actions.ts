"use server";

import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { establishDemoPhoneSession } from "@/shared/register/demoAuthBridge";
import {
  canonicalSixDigitOtp,
  generateSixDigitCode,
} from "@/shared/register/otpHelpers";
import {
  isRegisterPhoneDigitsValid,
  normalizeRegisterPhone,
} from "@/shared/register/phone";

const INVALID_PHONE_MSG =
  "Enter 8–15 digits including country code (e.g. Vietnam: 84912345678).";

export type SendRegisterOtpResult =
  | { success: true; demoCode: string }
  | { success: false; error: string };

/** Demo mode only: stores OTP in `otps` and returns code for on-screen display. */
export async function sendRegisterOtp(
  phoneRaw: string,
): Promise<SendRegisterOtpResult> {
  console.log("DEMO_OTP env:", process.env.NEXT_PUBLIC_DEMO_OTP);
  console.log("isDemo:", process.env.NEXT_PUBLIC_DEMO_OTP === "true");
  console.log(
    "[sendRegisterOtp] DEMO_OTP (runtime):",
    process.env.DEMO_OTP,
    "effective:",
    isDemoOtpRuntime(),
  );

  if (!isDemoOtpRuntime()) {
    return { success: false, error: "Use SMS send on the client in production." };
  }

  const phone = normalizeRegisterPhone(phoneRaw);
  if (!isRegisterPhoneDigitsValid(phone)) {
    return { success: false, error: INVALID_PHONE_MSG };
  }

  try {
    const supabase = createServiceRoleClient();
    const code = generateSixDigitCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error: deleteError } = await supabase
      .from("otps")
      .delete()
      .eq("phone", phone);

    if (deleteError) {
      console.error("[sendRegisterOtp] delete prior OTP rows", deleteError);
      return { success: false, error: "Could not send code. Try again." };
    }

    const { error: insertError } = await supabase.from("otps").insert({
      phone,
      code,
      expires_at: expiresAt,
    });

    if (insertError) {
      console.error("[sendRegisterOtp] insert", insertError);
      return { success: false, error: "Could not send code. Try again." };
    }

    console.log(`[sendRegisterOtp] DEMO OTP for ${phone}: ${code}`);

    return { success: true, demoCode: code };
  } catch (error) {
    console.error("[sendRegisterOtp]", error);
    return { success: false, error: "Could not send code. Try again." };
  }
}

export type VerifyDemoRegisterOtpResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "expired" | "server_error" };

export async function verifyDemoRegisterOtp(
  phoneRaw: string,
  codeRaw: string,
): Promise<VerifyDemoRegisterOtpResult> {
  if (!isDemoOtpRuntime()) {
    return { ok: false, reason: "server_error" };
  }

  const phone = normalizeRegisterPhone(phoneRaw);
  const code = codeRaw.replace(/\D/g, "").slice(0, 6);

  if (!isRegisterPhoneDigitsValid(phone) || code.length !== 6) {
    return { ok: false, reason: "invalid" };
  }

  let supabase;
  try {
    supabase = createServiceRoleClient();
  } catch {
    return { ok: false, reason: "server_error" };
  }

  const { data: latest } = await supabase
    .from("otps")
    .select("id, code, expires_at")
    .eq("phone", phone)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latest) {
    return { ok: false, reason: "invalid" };
  }

  const expiresAt = new Date(String(latest.expires_at));
  if (expiresAt.getTime() <= Date.now()) {
    await supabase.from("otps").delete().eq("id", latest.id);
    return { ok: false, reason: "expired" };
  }

  if (canonicalSixDigitOtp(latest.code) !== canonicalSixDigitOtp(code)) {
    return { ok: false, reason: "invalid" };
  }

  await supabase.from("otps").delete().eq("id", latest.id);

  const session = await establishDemoPhoneSession(phone);
  if (!session.ok) {
    return { ok: false, reason: "server_error" };
  }

  return { ok: true };
}
