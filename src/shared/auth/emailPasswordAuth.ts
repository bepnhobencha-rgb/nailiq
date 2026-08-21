"use server";

import { createClient } from "@/shared/lib/supabase/server";
import { consumePublicServerActionRateLimit } from "@/shared/security/publicServerActionRateLimit";

export type EmailPasswordAuthResult =
  | { ok: true; status: "signed_in" | "confirmation_required" }
  | {
      ok: false;
      error:
        | "invalid_input"
        | "invalid_credentials"
        | "account_exists"
        | "rate_limited"
        | "server_error";
    };

const EMAIL_RE = /^\S+@\S+\.\S+$/;

export async function authenticateWithEmailPassword(
  emailRaw: string,
  password: string,
  kind: "signin" | "signup",
): Promise<EmailPasswordAuthResult> {
  const email = emailRaw.trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254 || !password) {
    return { ok: false, error: "invalid_input" };
  }
  if (kind === "signup" && password.length < 8) {
    return { ok: false, error: "invalid_input" };
  }

  const rate = await consumePublicServerActionRateLimit({
    scope: `auth-password-${kind}`,
    identity: email,
  });
  if (rate === "limited") return { ok: false, error: "rate_limited" };
  if (rate === "unavailable") return { ok: false, error: "server_error" };

  try {
    const supabase = await createClient();
    if (kind === "signin") {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error || !data.user) {
        return { ok: false, error: "invalid_credentials" };
      }
      return { ok: true, status: "signed_in" };
    }

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: siteUrl ? `${siteUrl}/auth/callback` : "/auth/callback",
      },
    });
    if (error) {
      const message = error.message?.toLowerCase() ?? "";
      return {
        ok: false,
        error:
          message.includes("already") || message.includes("registered")
            ? "account_exists"
            : "server_error",
      };
    }
    return {
      ok: true,
      status: data.session ? "signed_in" : "confirmation_required",
    };
  } catch {
    return { ok: false, error: "server_error" };
  }
}
