import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  digitsToE164Phone,
  isRegisterPhoneDigitsValid,
  normalizeRegisterPhone,
} from "@/shared/register/phone";

function demoAuthEmailForDigits(digits: string): string {
  return `nailiq-${digits}@signup.nailiq.invalid`;
}

async function findAuthUserIdByEmail(
  admin: SupabaseClient,
  email: string,
): Promise<string | undefined> {
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) {
      console.error("[findAuthUserIdByEmail]", error);
      return undefined;
    }
    const hit = data.users.find((u) => u.email === email);
    if (hit) return hit.id;
    if (data.users.length < 200) break;
  }
  return undefined;
}

/**
 * Demo-only: validates OTP elsewhere; creates/updates Auth user and opens a real session (cookies).
 */
export async function establishDemoPhoneSession(
  digitsRaw: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const digits = normalizeRegisterPhone(digitsRaw);
  if (!isRegisterPhoneDigitsValid(digits)) {
    return { ok: false, error: "invalid_phone" };
  }

  const e164 = digitsToE164Phone(digits);
  if (!e164) {
    return { ok: false, error: "invalid_phone" };
  }

  let admin: SupabaseClient;
  try {
    admin = createServiceRoleClient();
  } catch {
    return { ok: false, error: "config" };
  }

  const email = demoAuthEmailForDigits(digits);
  const password = randomBytes(32).toString("base64url");

  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    phone: e164,
    phone_confirm: true,
    user_metadata: { nailiq_phone_digits: digits },
  });

  let userId = created.user?.id;

  if (cErr || !userId) {
    const msg = (cErr?.message ?? "").toLowerCase();
    const duplicate =
      msg.includes("already") ||
      msg.includes("registered") ||
      msg.includes("exists");
    if (!duplicate) {
      console.error("[establishDemoPhoneSession] createUser", cErr);
      return { ok: false, error: "create_failed" };
    }

    const found = await findAuthUserIdByEmail(admin, email);
    if (!found) {
      return { ok: false, error: "lookup_failed" };
    }

    userId = found;
    const { error: uErr } = await admin.auth.admin.updateUserById(userId, {
      password,
      phone: e164,
      phone_confirm: true,
      user_metadata: { nailiq_phone_digits: digits },
    });
    if (uErr) {
      console.error("[establishDemoPhoneSession] updateUser", uErr);
      return { ok: false, error: "update_failed" };
    }
  }

  const sessionClient = await createClient();
  const { error: sErr } = await sessionClient.auth.signInWithPassword({
    email,
    password,
  });
  if (sErr) {
    console.error("[establishDemoPhoneSession] signIn", sErr);
    return { ok: false, error: "signin_failed" };
  }

  return { ok: true };
}
