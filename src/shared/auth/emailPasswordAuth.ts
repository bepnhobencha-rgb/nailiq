"use server";

import { createClient } from "@/shared/lib/supabase/server";
import { consumePublicServerActionRateLimit } from "@/shared/security/publicServerActionRateLimit";

export type EmailPasswordAuthResult =
  | { ok: true; status: "signed_in" }
  | {
      ok: true;
      status: "confirmation_required";
      delivery: "requested" | "synthetic_no_delivery";
    }
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
const SYNTHETIC_EMAIL_SUFFIXES = [
  ".invalid",
  ".test",
  ".localhost",
  ".example",
] as const;

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

function isSyntheticEmail(email: string): boolean {
  const domain = email.split("@").at(-1) ?? "";
  return SYNTHETIC_EMAIL_SUFFIXES.some(
    (suffix) => domain === suffix.slice(1) || domain.endsWith(suffix),
  );
}

function syntheticEmailAllowed(): boolean {
  if (process.env.VERCEL_ENV === "production") return false;
  return (
    process.env.VERCEL_ENV === "preview" ||
    process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "test"
  );
}

function emailRedirectTo(): string {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";
  return siteUrl ? `${siteUrl}/auth/callback` : "/auth/callback";
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

  const syntheticEmail = isSyntheticEmail(email);
  if (kind === "signup" && syntheticEmail && !syntheticEmailAllowed()) {
    return { ok: false, error: "email_address_unusable" };
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

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: emailRedirectTo(),
      },
    });
    if (error) {
      return classifySignupError(error);
    }
    if (data.session) return { ok: true, status: "signed_in" };
    return {
      ok: true,
      status: "confirmation_required",
      delivery: syntheticEmail ? "synthetic_no_delivery" : "requested",
    };
  } catch {
    return { ok: false, error: "server_error" };
  }
}

export async function resendSignupConfirmationEmail(
  emailRaw: string,
): Promise<
  | { ok: true; status: "requested" | "synthetic_no_delivery" }
  | {
      ok: false;
      error:
        | "invalid_input"
        | "email_address_unusable"
        | "confirmation_email_unavailable"
        | "rate_limited"
        | "server_error";
    }
> {
  const email = emailRaw.trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return { ok: false, error: "invalid_input" };
  }

  const syntheticEmail = isSyntheticEmail(email);
  if (syntheticEmail) {
    return syntheticEmailAllowed()
      ? { ok: true, status: "synthetic_no_delivery" }
      : { ok: false, error: "email_address_unusable" };
  }

  const rate = await consumePublicServerActionRateLimit({
    scope: "auth-password-signup-resend",
    identity: email,
  });
  if (rate === "limited") return { ok: false, error: "rate_limited" };
  if (rate === "unavailable") return { ok: false, error: "server_error" };

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: emailRedirectTo() },
    });
    if (error) {
      const classified = classifySignupError(error);
      if (!classified.ok && classified.error === "rate_limited") {
        return { ok: false, error: "rate_limited" };
      }
      if (!classified.ok && classified.error === "email_address_unusable") {
        return { ok: false, error: "email_address_unusable" };
      }
      return { ok: false, error: "confirmation_email_unavailable" };
    }
    return { ok: true, status: "requested" };
  } catch {
    return { ok: false, error: "server_error" };
  }
}
