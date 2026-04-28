"use server";

import { randomInt, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { slugifySalonName } from "@/shared/lib/registerFlow";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  isRegisterPhoneDigitsValid,
  normalizeRegisterPhone,
} from "@/shared/register/phone";

function generateSixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Compare stored OTP with user input (DB may use int / numeric and drop leading zeros). */
function canonicalSixDigitOtp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value)).padStart(6, "0");
  }
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length >= 6) return digits.slice(-6);
  return digits.padStart(6, "0");
}

async function salonSlugTaken(
  supabase: SupabaseClient,
  slug: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("salons")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  return Boolean(data);
}

async function pickAvailableSalonSlug(
  supabase: SupabaseClient,
  baseSlug: string,
): Promise<{ slug: string; slugAdjusted: boolean }> {
  if (!(await salonSlugTaken(supabase, baseSlug))) {
    return { slug: baseSlug, slugAdjusted: false };
  }
  let n = 2;
  while (n < 500) {
    const candidate = `${baseSlug}-${n}`;
    if (!(await salonSlugTaken(supabase, candidate))) {
      return { slug: candidate, slugAdjusted: true };
    }
    n += 1;
  }
  throw new Error("slug_candidates_exhausted");
}

export type SendRegisterOtpResult =
  | { success: true }
  | { success: false; error: string };

const INVALID_PHONE_MSG =
  "Enter 8–15 digits including country code (e.g. Vietnam: 84912345678).";

export async function sendRegisterOtp(
  phoneRaw: string,
): Promise<SendRegisterOtpResult> {
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
      return { success: false, error: deleteError.message };
    }

    const { error: insertError } = await supabase.from("otps").insert({
      phone,
      code,
      expires_at: expiresAt,
    });

    if (insertError) {
      console.error("[sendRegisterOtp] insert", insertError);
      return { success: false, error: insertError.message };
    }

    if (process.env.NODE_ENV === "development") {
      console.log(`[NailIQ DEMO MODE] OTP for ${phone}: ${code}`);
    }

    return { success: true };
  } catch (error) {
    console.error("[sendRegisterOtp]", error);
    const message =
      error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
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

  let supabase;
  try {
    supabase = createServiceRoleClient();
  } catch {
    return { ok: false, reason: "invalid" };
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

  const completionExpires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const completionToken = randomUUID();

  const { data: tok, error } = await supabase
    .from("register_completion_tokens")
    .insert({
      phone,
      token: completionToken,
      expires_at: completionExpires,
    })
    .select("token")
    .single();

  if (error || !tok?.token) {
    console.error("[verifyRegisterOtp] token insert", error);
    return { ok: false, reason: "server_error" };
  }

  await supabase.from("otps").delete().eq("id", latest.id);

  return { ok: true, completionToken: String(tok.token) };
}

export async function validateRegisterCompletionToken(
  rawToken: string | undefined,
): Promise<{ valid: boolean }> {
  const token = rawToken?.trim();
  if (!token) return { valid: false };

  try {
    const supabase = createServiceRoleClient();
    const { data } = await supabase
      .from("register_completion_tokens")
      .select("expires_at")
      .eq("token", token)
      .maybeSingle();

    if (!data) return { valid: false };

    const tokenExpiry = new Date(String(data.expires_at));
    if (tokenExpiry.getTime() <= Date.now()) {
      await supabase.from("register_completion_tokens").delete().eq("token", token);
      return { valid: false };
    }

    return { valid: true };
  } catch (e) {
    console.error("[validateRegisterCompletionToken]", e);
    return { valid: false };
  }
}

export type CompleteSalonRegistrationResult =
  | { ok: true; slug: string; slugAdjusted: boolean }
  | {
      ok: false;
      error:
        | "invalid_name"
        | "session_expired"
        | "server_error"
        | "missing_token";
    };

export async function completeSalonRegistration(
  completionToken: string | undefined,
  salonNameRaw: string,
): Promise<CompleteSalonRegistrationResult> {
  const name = salonNameRaw.trim();
  if (!name || name.length > 120) {
    return { ok: false, error: "invalid_name" };
  }

  if (!completionToken?.trim()) {
    return { ok: false, error: "missing_token" };
  }

  let supabase;
  try {
    supabase = createServiceRoleClient();
  } catch {
    return { ok: false, error: "server_error" };
  }

  const { data: tokenRow } = await supabase
    .from("register_completion_tokens")
    .select("phone, expires_at")
    .eq("token", completionToken.trim())
    .maybeSingle();

  if (!tokenRow) {
    return { ok: false, error: "session_expired" };
  }

  const tokenExpiry = new Date(String(tokenRow.expires_at));
  if (tokenExpiry.getTime() <= Date.now()) {
    await supabase
      .from("register_completion_tokens")
      .delete()
      .eq("token", completionToken.trim());
    return { ok: false, error: "session_expired" };
  }

  const phone = String(tokenRow.phone);

  let slug: string;
  let slugAdjusted: boolean;
  try {
    const picked = await pickAvailableSalonSlug(
      supabase,
      slugifySalonName(name),
    );
    slug = picked.slug;
    slugAdjusted = picked.slugAdjusted;
  } catch (e) {
    console.error("[completeSalonRegistration] slug pick", e);
    return { ok: false, error: "server_error" };
  }

  const { data: salonRow, error: salonErr } = await supabase
    .from("salons")
    .insert({
      slug,
      name,
      phone,
    })
    .select("id")
    .single();

  if (salonErr || !salonRow?.id) {
    console.error("[completeSalonRegistration] salon insert", salonErr);
    return { ok: false, error: "server_error" };
  }

  const salonId = salonRow.id as string;

  const { error: svcErr } = await supabase.from("services").insert({
    salon_id: salonId,
    name: "Gel Manicure",
    price_cents: 4500,
    duration_minutes: 45,
    buffer_minutes: 10,
  });

  if (svcErr) {
    console.error("[completeSalonRegistration] services insert", svcErr);
    await supabase.from("salons").delete().eq("id", salonId);
    return { ok: false, error: "server_error" };
  }

  const { error: staffErr } = await supabase.from("staff").insert({
    salon_id: salonId,
    name: "Staff 1",
  });

  if (staffErr) {
    console.error("[completeSalonRegistration] staff insert", staffErr);
    await supabase.from("services").delete().eq("salon_id", salonId);
    await supabase.from("salons").delete().eq("id", salonId);
    return { ok: false, error: "server_error" };
  }

  await supabase
    .from("register_completion_tokens")
    .delete()
    .eq("token", completionToken.trim());

  return { ok: true, slug, slugAdjusted };
}
