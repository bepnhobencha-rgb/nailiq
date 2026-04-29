"use server";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  NAILQ_DEMO_SLUG_COOKIE,
  NAILQ_DEMO_SLUG_COOKIE_MAX_AGE_S,
} from "@/shared/lib/demoDashboardCookie";
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

function registerFlowDebugEnabled(): boolean {
  return (
    process.env.NODE_ENV === "development" ||
    process.env.DEBUG_REGISTER_FLOW === "1"
  );
}

function logRegisterFlow(label: string, payload: Record<string, unknown>): void {
  if (!registerFlowDebugEnabled()) return;
  console.log(`[register:${label}]`, payload);
}

/**
 * `salons.phone` stores normalized digits (matches registration).
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
    .select("slug")
    .eq("phone", normalizedDigits)
    .limit(1)
    .maybeSingle();

  logRegisterFlow("existingSalonCheck", {
    normalizedPhone: normalizedDigits,
    existingSalon: salon ?? null,
    error: salErr?.message ?? null,
  });

  if (salErr) {
    console.error("[lookupSalonSlugForOwnerPhone] salons", salErr);
    return null;
  }

  const slug = salon?.slug != null ? String(salon.slug).trim() : "";
  return slug || null;
}

/**
 * After OTP proves `normalizedDigits`, ensure the authenticated user has a
 * `salon_members` row for the salon whose `salons.phone` matches (dashboard RLS).
 */
async function ensureOwnerMembershipForVerifiedPhone(
  admin: ReturnType<typeof createServiceRoleClient>,
  sessionUserId: string,
  normalizedDigits: string,
  salonSlug: string,
): Promise<boolean> {
  const slug = salonSlug.trim();
  const { data: salon, error: salErr } = await admin
    .from("salons")
    .select("id, phone")
    .eq("slug", slug)
    .maybeSingle();

  if (salErr || !salon?.id) {
    console.error("[ensureOwnerMembershipForVerifiedPhone] salon", salErr);
    return false;
  }

  const phoneOnRow = normalizeRegisterPhone(String(salon.phone ?? ""));
  if (phoneOnRow !== normalizedDigits) {
    return false;
  }

  const { data: existing, error: exErr } = await admin
    .from("salon_members")
    .select("id")
    .eq("salon_id", salon.id)
    .eq("user_id", sessionUserId)
    .maybeSingle();

  if (exErr) {
    console.error("[ensureOwnerMembershipForVerifiedPhone] members read", exErr);
    return false;
  }

  if (existing) return true;

  const { error: insErr } = await admin.from("salon_members").insert({
    salon_id: salon.id,
    user_id: sessionUserId,
    role: "owner",
  });

  if (insErr) {
    console.error("[ensureOwnerMembershipForVerifiedPhone] insert", insErr);
    return false;
  }

  return true;
}

export type FinalizeRegisterSessionAfterPhoneOtpResult =
  | { ok: true; kind: "dashboard"; slug: string }
  | { ok: true; kind: "setup"; completionToken: string }
  | { ok: false; reason: "unauthorized" | "server_error" };

/**
 * Run after Supabase phone OTP succeeds **in the browser** (`verifyOtp` on client).
 * Server reads the session from cookies — avoids broken cookie writes from Server Actions.
 */
export async function finalizeRegisterSessionAfterPhoneOtp(
  phoneRaw: string,
): Promise<FinalizeRegisterSessionAfterPhoneOtpResult> {
  const phone = normalizeRegisterPhone(phoneRaw);
  if (!isRegisterPhoneDigitsValid(phone)) {
    return { ok: false, reason: "server_error" };
  }

  const supabase = await createClient();
  const {
    data: { user: sessionUser },
  } = await supabase.auth.getUser();

  if (!sessionUser) {
    return { ok: false, reason: "unauthorized" };
  }

  const slugForRegisteredPhone = await lookupSalonSlugForOwnerPhone(phone);
  if (slugForRegisteredPhone) {
    let adminSr;
    try {
      adminSr = createServiceRoleClient();
    } catch {
      adminSr = undefined;
    }
    if (adminSr) {
      const linked = await ensureOwnerMembershipForVerifiedPhone(
        adminSr,
        sessionUser.id,
        phone,
        slugForRegisteredPhone,
      );
      if (linked) {
        return { ok: true, kind: "dashboard", slug: slugForRegisteredPhone };
      }
    }
  }

  const { data: memRow, error: memErr } = await supabase
    .from("salon_members")
    .select("salon_id")
    .eq("user_id", sessionUser.id)
    .limit(1)
    .maybeSingle();

  if (memErr) {
    console.error(
      "[finalizeRegisterSessionAfterPhoneOtp] salon_members",
      memErr,
    );
  } else if (memRow?.salon_id) {
    const { data: salRow, error: salErr } = await supabase
      .from("salons")
      .select("slug")
      .eq("id", memRow.salon_id)
      .maybeSingle();

    if (salErr) {
      console.error("[finalizeRegisterSessionAfterPhoneOtp] salons slug", salErr);
    } else {
      const slug = salRow?.slug?.trim();
      if (slug) {
        return { ok: true, kind: "dashboard", slug: String(slug) };
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
      "[finalizeRegisterSessionAfterPhoneOtp] register_completion_tokens insert",
      tokErr,
    );
    return { ok: false, reason: "server_error" };
  }

  return { ok: true, kind: "setup", completionToken };
}

/**
 * Result of requesting a registration / sign-in OTP.
 * - `returning.code` is only set in demo OTP mode (modal). Never returns slug before verify.
 */
export type SendRegisterOtpResult =
  | { success: false; error: string }
  | { success: true; mode: "new"; code?: string }
  | { success: true; mode: "returning"; code?: string }
  | { success: true; mode: "demo"; code: string };

/** @alias SendRegisterOtpResult */
export type SendOtpResult = SendRegisterOtpResult;

export async function sendRegisterOtp(
  phoneRaw: string,
): Promise<SendRegisterOtpResult> {
  const isDemo = isDemoOtpRuntime();
  logRegisterFlow("sendOtp.env", {
    isDemo,
    DEMO_OTP: process.env.DEMO_OTP ?? "(unset)",
    NEXT_PUBLIC_DEMO_OTP: process.env.NEXT_PUBLIC_DEMO_OTP ?? "(unset)",
    serviceRoleKeyExists: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    serviceRoleKeyLength: process.env.SUPABASE_SERVICE_ROLE_KEY?.length ?? 0,
  });

  const phone = normalizeRegisterPhone(phoneRaw);
  if (!isRegisterPhoneDigitsValid(phone)) {
    return { success: false, error: INVALID_PHONE_MSG };
  }

  const isReturningOwner = Boolean(await lookupSalonSlugForOwnerPhone(phone));

  if (isDemo) {
    let supabase;
    try {
      supabase = createServiceRoleClient();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Missing Supabase service configuration.";
      console.error("[sendRegisterOtp] service role client", err);
      return {
        success: false,
        error:
          registerFlowDebugEnabled() || msg.includes("SUPABASE_SERVICE_ROLE_KEY")
            ? `${msg} Add SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_URL to .env.local.`
            : "Could not send code. Server configuration error.",
      };
    }

    try {
      const code = generateSixDigitCode();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      logRegisterFlow("sendOtp.demo.insert", {
        normalizedPhone: phone,
        insertingOtp: true,
      });

      const { error: deleteError } = await supabase
        .from("otps")
        .delete()
        .eq("phone", phone);

      if (deleteError) {
        console.error("[sendRegisterOtp] delete prior OTP rows", deleteError);
        return {
          success: false,
          error: deleteError.message || "Could not send code. Try again.",
        };
      }

      const { error: insertError } = await supabase.from("otps").insert({
        phone,
        code,
        expires_at: expiresAt,
      });

      if (insertError) {
        console.error("[sendRegisterOtp] OTP insert error:", insertError);
        return {
          success: false,
          error:
            insertError.message ||
            "Could not send code. Check otps table and service role permissions.",
        };
      }

      if (isReturningOwner) {
        return { success: true, mode: "returning", code };
      }

      return { success: true, mode: "demo", code };
    } catch (error) {
      console.error("[sendRegisterOtp]", error);
      const fallback =
        error instanceof Error ? error.message : "Could not send code. Try again.";
      return { success: false, error: fallback };
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

    if (isReturningOwner) {
      return { success: true, mode: "returning" };
    }

    return { success: true, mode: "new" };
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
  const phone = normalizeRegisterPhone(phoneRaw);
  const code = codeRaw.replace(/\D/g, "").slice(0, 6);

  if (!isRegisterPhoneDigitsValid(phone) || code.length !== 6) {
    return { ok: false, reason: "invalid" };
  }

  if (!isDemoOtpRuntime()) {
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

  const returningSlug = await lookupSalonSlugForOwnerPhone(phone);
  if (returningSlug) {
    const cookieStore = await cookies();
    cookieStore.set(NAILQ_DEMO_SLUG_COOKIE, returningSlug, {
      path: "/",
      maxAge: NAILQ_DEMO_SLUG_COOKIE_MAX_AGE_S,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
    if (registerFlowDebugEnabled()) {
      console.log("verifyRegisterOtp returning owner → redirect", {
        returningOwnerSlug: returningSlug,
      });
    }
    redirect(`/dashboard/${encodeURIComponent(returningSlug)}`);
  }

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

  const result = { ok: true as const, completionToken };
  if (registerFlowDebugEnabled()) {
    console.log("verifyRegisterOtp result:", result);
    console.log("returningOwnerSlug:", null);
  }
  return result;
}
