"use client";

import { useRouter } from "next/navigation";
import { useId, useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { createClient } from "@/shared/lib/supabase/client";
import { resolvePostAuthRedirect } from "@/shared/auth/resolvePostAuthRedirect";

type Mode = "login" | "register";

/**
 * `compact` — legacy layout used on /login and other surfaces. The email
 *             magic-link form is hidden under an "Other options" toggle.
 * `open`    — used on /register. Email field is visible by default and
 *             (when `enablePassword`) a "Sign in with password" toggle
 *             reveals a password input + Sign in / Sign up buttons.
 */
type Layout = "compact" | "open";

type Props = {
  mode: Mode;
  layout?: Layout;
  /** Only honored when `layout="open"`. */
  enablePassword?: boolean;
};

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const MIN_PASSWORD_LEN = 8;

function authCallbackUrl(): string {
  const siteUrl =
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "")
      : "";
  return siteUrl ? `${siteUrl}/auth/callback` : "/auth/callback";
}

export function SocialAuthButtons({
  mode,
  layout = "compact",
  enablePassword = false,
}: Props) {
  // Source of truth = the EN/VI toggle in the marketing nav and the auth
  // shell. Previously this read `useBrowserLanguage`, which caused mixed
  // EN/VI strings on `/register` for VI-locale browsers.
  const { language } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language).auth, [language]);
  const router = useRouter();

  // In "compact" layout the email form starts collapsed; in "open" it's
  // always visible (the "Other options" toggle is suppressed).
  const [showEmail, setShowEmail] = useState(layout === "open");
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailSentTo, setEmailSentTo] = useState<string | null>(null);
  const [signUpConfirmTo, setSignUpConfirmTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<
    "google" | "magic" | "signin" | "signup" | null
  >(null);
  const [pending, startTransition] = useTransition();
  const emailSectionId = useId();
  const passwordSectionId = useId();

  const passwordSupported = layout === "open" && enablePassword;

  const validEmail = (raw: string): string | null => {
    const trimmed = raw.trim().toLowerCase();
    if (!EMAIL_RE.test(trimmed)) return null;
    if (trimmed.length > 254) return null;
    return trimmed;
  };

  const onGoogle = () => {
    setError(null);
    setInfo(null);
    setPendingAction("google");
    startTransition(async () => {
      const supabase = createClient();
      const { error: oauthErr } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: authCallbackUrl() },
      });
      if (oauthErr) {
        setError(oauthErr.message ?? t.googleSigninFailed);
        setPendingAction(null);
      }
      // On success the browser is redirected by Supabase — keep pending
      // state set so the button stays in its loading state until the
      // redirect actually starts.
    });
  };

  const onMagicLink = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    const normalized = validEmail(email);
    if (!normalized) {
      setError(t.emailInvalid);
      return;
    }
    setPendingAction("magic");
    startTransition(async () => {
      const supabase = createClient();
      const { error: otpErr } = await supabase.auth.signInWithOtp({
        email: normalized,
        options: {
          emailRedirectTo: authCallbackUrl(),
          shouldCreateUser: true,
        },
      });
      setPendingAction(null);
      if (otpErr) {
        setError(otpErr.message ?? t.magicLinkSendFailed);
        return;
      }
      // Surface the dedicated "check your email" screen so the user has
      // an obvious next step instead of a tiny green status line.
      setEmailSentTo(normalized);
    });
  };

  const onPasswordSubmit = (kind: "signin" | "signup") => {
    setError(null);
    setInfo(null);
    const normalized = validEmail(email);
    if (!normalized) {
      setError(t.emailRequired);
      return;
    }
    if (!password) {
      setError(t.passwordRequired);
      return;
    }
    if (kind === "signup" && password.length < MIN_PASSWORD_LEN) {
      setError(t.passwordTooShort);
      return;
    }
    setPendingAction(kind);
    startTransition(async () => {
      const supabase = createClient();
      if (kind === "signin") {
        const { error: signInErr } = await supabase.auth.signInWithPassword({
          email: normalized,
          password,
        });
        if (signInErr) {
          setError(t.signInFailed);
          setPendingAction(null);
          return;
        }
        const dest = await resolvePostAuthRedirect();
        router.push(dest);
        router.refresh();
        return;
      }
      // Sign up — Supabase may or may not require email confirmation.
      const { data, error: signUpErr } = await supabase.auth.signUp({
        email: normalized,
        password,
        options: { emailRedirectTo: authCallbackUrl() },
      });
      if (signUpErr) {
        const msg = signUpErr.message?.toLowerCase() ?? "";
        if (msg.includes("already") || msg.includes("registered")) {
          setError(t.accountExists);
        } else {
          setError(t.signUpFailed);
        }
        setPendingAction(null);
        return;
      }
      // If email confirmation is enabled in Supabase, `session` is null
      // and the user must click the link in their inbox before we can
      // resolve their salon membership.
      if (!data.session) {
        setSignUpConfirmTo(normalized);
        setPendingAction(null);
        return;
      }
      const dest = await resolvePostAuthRedirect();
      router.push(dest);
      router.refresh();
    });
  };

  const magicLinkButtonLabel =
    mode === "login" ? t.sendLoginLink : t.sendSignupLink;

  // ── Post-action confirmation screens ──────────────────────────────────
  if (emailSentTo) {
    return (
      <div className="mt-6 flex flex-col gap-4 text-center">
        <h2 className="text-lg font-semibold text-nq-foreground">
          {t.magicLinkSentTitle}
        </h2>
        <p className="text-sm text-nq-muted">
          {t.magicLinkSentBody.replace("{email}", emailSentTo)}
        </p>
        <button
          type="button"
          className="mt-2 min-h-11 text-sm text-nq-primary-soft underline-offset-4 hover:underline"
          onClick={() => {
            setEmailSentTo(null);
            setEmail("");
            setPassword("");
            setError(null);
            setInfo(null);
          }}
        >
          {t.useDifferentEmail}
        </button>
      </div>
    );
  }

  if (signUpConfirmTo) {
    return (
      <div className="mt-6 flex flex-col gap-4 text-center">
        <h2 className="text-lg font-semibold text-nq-foreground">
          {t.signUpConfirmEmailTitle}
        </h2>
        <p className="text-sm text-nq-muted">
          {t.signUpConfirmEmailBody.replace("{email}", signUpConfirmTo)}
        </p>
        <button
          type="button"
          className="mt-2 min-h-11 text-sm text-nq-primary-soft underline-offset-4 hover:underline"
          onClick={() => {
            setSignUpConfirmTo(null);
            setEmail("");
            setPassword("");
            setError(null);
            setInfo(null);
          }}
        >
          {t.useDifferentEmail}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-6 flex flex-col gap-3">
      <Button
        type="button"
        variant={layout === "open" ? "primary" : "secondary"}
        size="lg"
        className="w-full min-h-11"
        loading={pending && pendingAction === "google"}
        disabled={pending}
        onClick={onGoogle}
      >
        {t.continueWithGoogle}
      </Button>

      <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.18em] text-nq-muted">
        <span className="h-px flex-1 bg-nq-border" />
        <span>{t.orDivider}</span>
        <span className="h-px flex-1 bg-nq-border" />
      </div>

      {/* Compact layout keeps the legacy "Other options" toggle so /login
          and existing surfaces don't change shape. The `open` layout
          renders the email form inline. */}
      {layout === "compact" ? (
        <button
          type="button"
          aria-expanded={showEmail}
          aria-controls={emailSectionId}
          data-testid="social-auth-other-options-toggle"
          onClick={() => {
            setError(null);
            setInfo(null);
            setShowEmail((prev) => !prev);
          }}
          className="self-center text-sm text-nq-muted underline-offset-4 transition hover:text-nq-foreground hover:underline"
        >
          {showEmail ? t.hideOptions : t.otherOptions}
        </button>
      ) : null}

      {showEmail ? (
        <form
          id={emailSectionId}
          onSubmit={onMagicLink}
          method="post"
          className="flex flex-col gap-3"
        >
          <Input
            type="email"
            inputMode="email"
            autoComplete="email"
            aria-label={t.emailLabel}
            placeholder={t.emailPlaceholder}
            value={email}
            onChange={(ev) => {
              setEmail(ev.target.value);
              if (error) setError(null);
            }}
            aria-invalid={Boolean(error)}
            error={Boolean(error)}
            autoFocus={layout === "compact"}
          />
          <Button
            type="submit"
            variant={layout === "open" ? "secondary" : "ghost"}
            size="md"
            className="w-full min-h-11"
            loading={pending && pendingAction === "magic"}
            disabled={pending}
          >
            {magicLinkButtonLabel}
          </Button>
        </form>
      ) : null}

      {passwordSupported ? (
        <>
          <button
            type="button"
            aria-expanded={showPassword}
            aria-controls={passwordSectionId}
            data-testid="social-auth-password-toggle"
            onClick={() => {
              setError(null);
              setInfo(null);
              setShowPassword((prev) => !prev);
            }}
            className="self-center text-sm text-nq-muted underline-offset-4 transition hover:text-nq-foreground hover:underline"
          >
            {showPassword ? t.hidePasswordToggle : t.showPasswordToggle}
          </button>
          {showPassword ? (
            <div
              id={passwordSectionId}
              className="flex flex-col gap-3 rounded-2xl border border-nq-border bg-nq-surface/40 p-3"
            >
              <Input
                type="password"
                autoComplete="current-password"
                placeholder={t.passwordPlaceholder}
                value={password}
                onChange={(ev) => {
                  setPassword(ev.target.value);
                  if (error) setError(null);
                }}
                aria-invalid={Boolean(error)}
                error={Boolean(error)}
              />
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="primary"
                  size="md"
                  className="w-full min-h-11"
                  loading={pending && pendingAction === "signin"}
                  disabled={pending}
                  onClick={() => onPasswordSubmit("signin")}
                >
                  {pending && pendingAction === "signin"
                    ? t.signingIn
                    : t.signInButton}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  className="w-full min-h-11"
                  loading={pending && pendingAction === "signup"}
                  disabled={pending}
                  onClick={() => onPasswordSubmit("signup")}
                >
                  {pending && pendingAction === "signup"
                    ? t.signingUp
                    : t.signUpButton}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {error ? (
        <p className="text-sm text-nq-error" role="status">
          {error}
        </p>
      ) : null}
      {info ? (
        <p className="text-sm text-nq-primary-soft" role="status">
          {info}
        </p>
      ) : null}
    </div>
  );
}
