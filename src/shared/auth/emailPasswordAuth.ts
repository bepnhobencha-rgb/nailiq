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
        | "email_address_unusable"
        | "confirmation_email_unavailable"
        | "rate_limited"
        | "server_error";
    };

const EMAIL_RE = /^\S+@\S+\.\S+$/;

type AuthProviderError = {
  code?: unknown;
  message?: unknown;
};

function classifySignupError(error: AuthProviderError): EmailPasswordAuthResult {
  const code = typeof error.code === "string" ? error.code.toLowerCase() : "";
  const message =
    typeof error.message === "string" ? error.message.toLowerCase() : "";

  if (
    code === "user_already_exists" ||
    code === "email_exists" ||
    message.includes("already") ||
    message.includes("registered")
  ) {
    return { ok: false, error: "account_exists" };
  }

  if (code === "email_address_invalid") {
    return { ok: false, error: "email_address_unusable" };
  }

  if (
    code === "over_email_send_rate_limit" ||
    message.includes("email rate limit") ||
    message.includes("too many requests")
  ) {
    return { ok: false, error: "rate_limited" };
  }

  if (
    code === "email_address_not_authorized" ||
    message.includes("sending confirmation email") ||
    message.includes("confirmation email")
  ) {
    return { ok: false, error: "confirmation_email_unavailable" };
  }

  return { ok: false, error: "server_error" };
}

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
      return classifySignupError(error);
    }
    return {
      ok: true,
      status: data.session ? "signed_in" : "confirmation_required",
    };
  } catch {
    return { ok: false, error: "server_error" };
  }
}
