"use server";

import { randomUUID } from "node:crypto";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";
import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  canonicalSixDigitOtp,
  generateSixDigitCode,
} from "@/shared/register/otpHelpers";
import {
  digitsToE164Phone,
  isRegisterPhoneDigitsValid,
  normalizeRegisterPhone,
} from "@/shared/register/phone";

const INVALID_PHONE_MSG =
  "Enter 8–15 digits including country code (e.g. Vietnam: 84912345678).";

export type SendRegisterOtpResult =
  | { success: false; error: string }
  | { success: true; mode: "demo"; code: string }
  | { success: true; mode: "sms" };

export async function sendRegisterOtp(
  phoneRaw: string,
): Promise<SendRegisterOtpResult> {
  const isDemo = isDemoOtpRuntime();
  const phone = normalizeRegisterPhone(phoneRaw);
  if (!isRegisterPhoneDigitsValid(phone)) {
    return { success: false, error: INVALID_PHONE_MSG };
  }

  if (isDemo) {
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

      return { success: true, mode: "demo", code };
    } catch (error) {
      console.error("[sendRegisterOtp]", error);
      return { success: false, error: "Could not send code. Try again." };
    }
  }

  const e164 = digitsToE164Phone(phone);
  if (!e164) {
    return { success: false, error: INVALID_PHONE_MSG };
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithOtp({
      phone: e164,
      options: { shouldCreateUser: true },
    });

    if (error) {
      console.error("[sendRegisterOtp] signInWithOtp", error);
      return {
        success: false,
        error:
          error.message ||
          "Could not send SMS. Enable Phone auth in Supabase or try again.",
      };
    }

    return { success: true, mode: "sms" };
  } catch (error) {
    console.error("[sendRegisterOtp]", error);
    return { success: false, error: "Could not send SMS. Try again." };
  }
}

export type VerifyRegisterOtpResult =
  | { ok: true; completionToken: string }
  | { ok: false; reason: "invalid" | "expired" | "server_error" };

export async function verifyRegisterOtp(
  phoneRaw: string,
  codeRaw: string,
): Promise<VerifyRegisterOtpResult> {
  const isDemo = isDemoOtpRuntime();
  const phone = normalizeRegisterPhone(phoneRaw);
  const code = codeRaw.replace(/\D/g, "").slice(0, 6);

  if (!isRegisterPhoneDigitsValid(phone) || code.length !== 6) {
    return { ok: false, reason: "invalid" };
  }

  if (!isDemo) {
    const e164 = digitsToE164Phone(phone);
    if (!e164) {
      return { ok: false, reason: "invalid" };
    }

    try {
      const supabase = await createClient();
      const { error } = await supabase.auth.verifyOtp({
        phone: e164,
        token: code,
        type: "sms",
      });

      if (error) {
        console.error("[verifyRegisterOtp] verifyOtp", error);
        const msg = error.message?.toLowerCase() ?? "";
        if (msg.includes("expired")) {
          return { ok: false, reason: "expired" };
        }
        return { ok: false, reason: "invalid" };
      }

      const completionToken = randomUUID();
      const tokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      let adminInsert;
      try {
        adminInsert = createServiceRoleClient();
      } catch {
        return { ok: false, reason: "server_error" };
      }

      const { error: tokErr } = await adminInsert
        .from("register_completion_tokens")
        .insert({
          phone,
          token: completionToken,
          expires_at: tokenExpiresAt,
        });

      if (tokErr) {
        console.error(
          "[verifyRegisterOtp] register_completion_tokens insert",
          tokErr,
        );
        return { ok: false, reason: "server_error" };
      }

      return { ok: true, completionToken };
    } catch (error) {
      console.error("[verifyRegisterOtp]", error);
      return { ok: false, reason: "server_error" };
    }
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

  const completionToken = randomUUID();
  const tokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const { error: tokErr } = await supabase
    .from("register_completion_tokens")
    .insert({
      phone,
      token: completionToken,
      expires_at: tokenExpiresAt,
    });

  if (tokErr) {
    console.error(
      "[verifyRegisterOtp] register_completion_tokens insert",
      tokErr,
    );
    return { ok: false, reason: "server_error" };
  }

  return { ok: true, completionToken };
}
