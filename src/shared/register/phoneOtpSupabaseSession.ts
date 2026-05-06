import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/shared/lib/supabase/server";
import { ensureSupabaseAuthE164 } from "@/shared/register/phone";

/** Structured server logs for Supabase Auth failures (no secrets). */
function logSupabaseAuthStepFailure(
  step: "createUser" | "listUsers" | "signInWithPassword" | "updateUser",
  error: unknown,
): void {
  if (error && typeof error === "object") {
    const e = error as {
      message?: string;
      status?: number;
      code?: string;
      name?: string;
    };
    console.error("[phoneOtpSupabaseSession] step:", step, {
      supabaseMessage: e.message,
      supabaseStatus: e.status,
      supabaseCode: e.code,
      supabaseName: e.name,
      fullError: error,
    });
  } else {
    console.error("[phoneOtpSupabaseSession] step:", step, {
      supabaseMessage: String(error),
      fullError: error,
    });
  }
}

function samePhoneDigits(a: string, b: string): boolean {
  const da = a.replace(/\D/g, "");
  const db = b.replace(/\D/g, "");
  return da.length > 0 && da === db;
}

async function findAuthUserIdByPhone(
  admin: SupabaseClient,
  e164Phone: string,
): Promise<string | null> {
  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 100,
    });
    if (error) {
      logSupabaseAuthStepFailure("listUsers", error);
      return null;
    }
    const users = data?.users ?? [];
    const found = users.find((u) => samePhoneDigits(u.phone ?? "", e164Phone));
    if (found?.id) return found.id;
    if (users.length < 100) break;
    page += 1;
    if (page > 100) break;
  }
  return null;
}

async function signInWithPhonePassword(
  e164Phone: string,
  password: string,
): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    phone: e164Phone,
    password,
  });
  if (error) {
    logSupabaseAuthStepFailure("signInWithPassword", error);
    throw new Error("auth_signin_failed");
  }
}

/**
 * After an external OTP provider (e.g. Twilio Verify) approves the phone,
 * ensure a Supabase Auth user exists and open a browser session via the SSR
 * client (cookies).
 */
export async function signInSupabaseWithPhoneAfterExternalOtp(
  admin: SupabaseClient,
  e164Phone: string,
): Promise<void> {
  const phone = ensureSupabaseAuthE164(e164Phone);
  if (!phone) {
    console.error(
      "[signInSupabaseWithPhoneAfterExternalOtp] invalid phone for Supabase Auth (expected E.164 with +)",
      { inputLength: e164Phone.length },
    );
    throw new Error("auth_invalid_phone");
  }

  const password = randomBytes(32).toString("base64url");

  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    phone,
    phone_confirm: true,
    password,
  });

  if (!cErr && created.user?.id) {
    await signInWithPhonePassword(phone, password);
    return;
  }

  const msg = (cErr?.message ?? "").toLowerCase();
  const duplicate =
    msg.includes("already") ||
    msg.includes("registered") ||
    msg.includes("exists") ||
    msg.includes("duplicate");

  if (!duplicate) {
    logSupabaseAuthStepFailure("createUser", cErr);
    throw new Error("auth_create_failed");
  }

  const userId = await findAuthUserIdByPhone(admin, phone);
  if (!userId) {
    console.error(
      "[signInSupabaseWithPhoneAfterExternalOtp] duplicate phone but user not found in listUsers",
    );
    throw new Error("auth_user_not_found");
  }

  const { error: uErr } = await admin.auth.admin.updateUserById(userId, {
    password,
  });
  if (uErr) {
    logSupabaseAuthStepFailure("updateUser", uErr);
    throw new Error("auth_update_failed");
  }

  await signInWithPhonePassword(phone, password);
}
