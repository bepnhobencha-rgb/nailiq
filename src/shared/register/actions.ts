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

/**
 * `salons.phone` stores normalized digits (matches registration). Salon must have ≥1 salon_members row.
 */
async function lookupSalonSlugForOwnerPhone(
  normalizedDigits: string,
): Promise<string | null> {
  let admin;
  try {
    admin = createServiceRoleClient();
  } catch {
    return null;
  }

  const { data: salon, error: salErr } = await admin
    .from("salons")
    .select("id, slug")
    .eq("phone", normalizedDigits)
    .maybeSingle();

  if (salErr) {
    console.error("[lookupSalonSlugForOwnerPhone] salons", salErr);
    return null;
  }
  if (!salon?.id) return null;

  const { count, error: mErr } = await admin
    .from("salon_members")
    .select("*", { count: "exact", head: true })
    .eq("salon_id", salon.id);

  if (mErr) {
    console.error("[lookupSalonSlugForOwnerPhone] salon_members", mErr);
    return null;
  }
  if ((count ?? 0) < 1) return null;

  const slug = salon.slug?.trim();
  return slug ? String(slug) : null;
}

export type SendRegisterOtpResult =
  | { success: false; error: string }
  | {
      success: true;
      mode: "returning";
      slug: string;
      /** Present in demo OTP path only */
      demoCode?: string;
    }
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

  const existingSlug = await lookupSalonSlugForOwnerPhone(phone);

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

      if (existingSlug) {
        return {
          success: true,
          mode: "returning",
          slug: existingSlug,
          demoCode: code,
        };
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

    if (existingSlug) {
      return { success: true, mode: "returning", slug: existingSlug };
    }

    return { success: true, mode: "sms" };
  } catch (error) {
    console.error("[sendRegisterOtp]", error);
    return { success: false, error: "Could not send SMS. Try again." };
  }
}

export type VerifyRegisterOtpResult =
  | {
      ok: true;
      /** Present for net-new salon registration (used by `/register/setup`). */
      completionToken: string;
      /** When this phone already completed signup, navigate here and skip setup. */
      returningOwnerSlug?: string;
    }
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

      const {
        data: { user: sessionUser },
      } = await supabase.auth.getUser();

      if (sessionUser) {
        const { data: memRow, error: memErr } = await supabase
          .from("salon_members")
          .select("salon_id")
          .eq("user_id", sessionUser.id)
          .limit(1)
          .maybeSingle();

        if (memErr) {
          console.error("[verifyRegisterOtp] salon_members", memErr);
        } else if (memRow?.salon_id) {
          const { data: salRow, error: salErr } = await supabase
            .from("salons")
            .select("slug")
            .eq("id", memRow.salon_id)
            .maybeSingle();

          if (salErr) {
            console.error("[verifyRegisterOtp] salons slug", salErr);
          } else {
            const slug = salRow?.slug?.trim();
            if (slug) {
              return {
                ok: true,
                completionToken: "",
                returningOwnerSlug: String(slug),
              };
            }
          }
        }
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
