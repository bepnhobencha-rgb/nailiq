import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/shared/lib/supabase/server";

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
      console.error("[findAuthUserIdByPhone] listUsers", error);
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
    console.error("[signInWithPhonePassword]", error);
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
  const password = randomBytes(32).toString("base64url");

  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    phone: e164Phone,
    phone_confirm: true,
    password,
  });

  if (!cErr && created.user?.id) {
    await signInWithPhonePassword(e164Phone, password);
    return;
  }

  const msg = (cErr?.message ?? "").toLowerCase();
  const duplicate =
    msg.includes("already") ||
    msg.includes("registered") ||
    msg.includes("exists") ||
    msg.includes("duplicate");

  if (!duplicate) {
    console.error("[signInSupabaseWithPhoneAfterExternalOtp] createUser", cErr);
    throw new Error("auth_create_failed");
  }

  const userId = await findAuthUserIdByPhone(admin, e164Phone);
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
    console.error("[signInSupabaseWithPhoneAfterExternalOtp] updateUser", uErr);
    throw new Error("auth_update_failed");
  }

  await signInWithPhonePassword(e164Phone, password);
}
