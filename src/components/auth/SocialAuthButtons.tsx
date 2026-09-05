"use client";

import {
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { createClient } from "@/shared/lib/supabase/client";
import { authenticateWithEmailPassword } from "@/shared/auth/emailPasswordAuth";
import { sendEmailMagicLink } from "@/shared/register/actions";

// Google OAuth is blocked by Error 403 disallowed_useragent when the auth flow
// is triggered inside in-app browsers (Facebook Messenger, Instagram, Twitter, etc.)
// because they use WebViews that don't meet Google's "secure browser" policy.
// Detecting them client-side lets us show a friendly banner instead of letting
// the user click through and hit Google's opaque error page.
function detectInAppBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // Facebook / Messenger
  if (/FBAN|FBAV|FB_IAB|FB4A|FBIOS/.test(ua)) return true;
  // Instagram
  if (/Instagram/.test(ua)) return true;
  // Twitter / X
  if (/Twitter/.test(ua)) return true;
  // Line
  if (/Line\//.test(ua)) return true;
  // Snapchat
  if (/Snapchat/.test(ua)) return true;
  // TikTok
  if (/musical_ly|TikTok/.test(ua)) return true;
  // Generic Android WebView ("wv" token in UA)
  if (/Android/.test(ua) && /wv/.test(ua)) return true;
  return false;
}

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
const noopSubscribe = () => () => {};

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

  // In "compact" layout the email form starts collapsed; in "open" it's
  // always visible (the "Other options" toggle is suppressed).
  const [showEmail, setShowEmail] = useState(layout === "open");
  // Password form is default in open+enablePassword layout — familiar for older users.
  const [showPassword, setShowPassword] = useState(layout === "open" && enablePassword);
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
  // Server snapshot stays false for deterministic HTML; React reads the
  // user-agent snapshot after hydration without a state-setting effect.
  const isInAppBrowser = useSyncExternalStore(
    noopSubscribe,
    detectInAppBrowser,
    () => false,
  );
  // Auth controls are server-rendered before their click handlers exist.
  // Keep them disabled for that brief window so a fast tap is not silently
  // lost (most visible on mobile/WebKit and under a busy main thread).
  const isHydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );

  const passwordSupported = layout === "open" && enablePassword;

  const validEmail = (raw: string): string | null => {
    const trimmed = raw.trim().toLowerCase();
    if (!EMAIL_RE.test(trimmed)) return null;
    if (trimmed.length > 254) return null;
    return trimmed;
  };

  const getPasswordStrength = (pwd: string): "weak" | "medium" | "strong" => {
    if (pwd.length < MIN_PASSWORD_LEN) return "weak";
    const hasUpper = /[A-Z]/.test(pwd);
    const hasNumber = /\d/.test(pwd);
    if (hasUpper && hasNumber) return "strong";
    if (hasUpper || hasNumber) return "medium";
    return "weak";
  };

  const passwordStrength = getPasswordStrength(password);
  const isPasswordAcceptable = passwordStrength === "medium" || passwordStrength === "strong";

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
      // Switch to magic-link mode so password field disappears and the
      // user sees a clean "enter email → send link" form.
      if (passwordSupported && showPassword) setShowPassword(false);
      setError(email.trim() ? t.emailInvalid : t.emailRequired);
      return;
    }
    setPendingAction("magic");
    startTransition(async () => {
      const result = await sendEmailMagicLink(normalized);
      setPendingAction(null);
      if (!result.success) {
        setError(t.magicLinkSendFailed);
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
      const result = await authenticateWithEmailPassword(
        normalized,
        password,
        kind,
      );
      if (!result.ok) {
        if (kind === "signin") {
          setError(t.signInFailed);
        } else if (result.error === "account_exists") {
          setError(t.accountExists);
        } else {
          setError(t.signUpFailed);
        }
        setPendingAction(null);
        return;
      }
      if (kind === "signin" || result.status === "signed_in") {
        // Full navigation to /register/setup: the new session cookie is sent with
        // the next browser request, so the server can read it correctly.
        // /register/setup handles all cases: no salon → wizard, existing salon →
        // dashboard redirect.  Using router.push races with cookie propagation.
        window.location.assign("/register/setup");
        return;
      }
      setSignUpConfirmTo(normalized);
      setPendingAction(null);
    });
  };

  const magicLinkButtonLabel =
    mode === "login" ? t.sendLoginLink : t.sendSignupLink;
  const primaryPasswordAction = mode === "register" ? "signup" : "signin";
  const secondaryPasswordAction = mode === "register" ? "signin" : "signup";
  const primaryPasswordLabel =
    primaryPasswordAction === "signup" ? t.signUpButton : t.signInButton;
  const secondaryPasswordLabel =
    mode === "register" ? t.existingAccountSignInButton : t.signUpButton;

  const passwordActionLabel = (
    action: "signin" | "signup",
    defaultLabel: string,
  ) => {
    if (!pending || pendingAction !== action) return defaultLabel;
    return action === "signup" ? t.signingUp : t.signingIn;
  };

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
    <div
      className="mt-6 flex flex-col gap-3"
      data-testid="social-auth-controls"
      data-hydrated={isHydrated ? "true" : "false"}
    >
      {/* In-app browser guard — Google blocks OAuth in WebViews (Error 403 disallowed_useragent) */}
      {isInAppBrowser ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800/40 dark:bg-amber-950/30">
          <p className="text-sm text-amber-800 dark:text-amber-300">
            {t.inAppBrowserWarning}
          </p>
          <button
            type="button"
            className="mt-2 text-sm font-medium text-amber-900 underline underline-offset-4 dark:text-amber-200"
            onClick={() => {
              // window.open with _blank is the most reliable way to escape an in-app
              // browser on both iOS (Safari handoff) and Android (intent chooser).
              window.open(window.location.href, "_blank", "noopener,noreferrer");
            }}
          >
            {t.openInBrowser}
          </button>
        </div>
      ) : null}
      {/* Google — primary action, large touch target */}
      <Button
        type="button"
        variant={layout === "open" ? "primary" : "secondary"}
        size="lg"
        className="w-full min-h-[52px] gap-3 text-base"
        loading={pending && pendingAction === "google"}
        disabled={!isHydrated || pending || isInAppBrowser}
        onClick={onGoogle}
      >
        {/* Google "G" logo */}
        <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" aria-hidden="true">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        {t.continueWithGoogle}
      </Button>
      {layout === "open" ? (
        <p className="text-center text-xs text-nq-muted">{t.googleHelperText}</p>
      ) : null}

      <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.18em] text-nq-muted">
        <span className="h-px flex-1 bg-nq-border" />
        <span>{t.orDivider}</span>
        <span className="h-px flex-1 bg-nq-border" />
      </div>

      {/* Compact layout keeps the legacy "Other options" toggle so /login
          and existing surfaces don't change shape. Open layout renders inline. */}
      {layout === "compact" ? (
        <button
          type="button"
          aria-expanded={showEmail}
          aria-controls={emailSectionId}
          data-testid="social-auth-other-options-toggle"
          disabled={!isHydrated}
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
        <div id={emailSectionId} className="flex flex-col gap-3">
          {/* In open+password mode: label above the email section */}
          {passwordSupported ? (
            <p className="text-sm font-semibold text-nq-foreground">
              {mode === "register"
                ? t.emailSignupSectionLabel
                : t.emailSectionLabel}
            </p>
          ) : null}

          {/* Email input — shared by both magic-link and password flows */}
          <Input
            type="email"
            inputMode="email"
            autoComplete="email"
            aria-label={t.emailLabel}
            placeholder={t.emailPlaceholder}
            className="text-base min-h-[48px]"
            value={email}
            onChange={(ev) => {
              setEmail(ev.target.value);
              if (error) setError(null);
            }}
            aria-invalid={Boolean(error)}
            error={Boolean(error)}
            autoFocus={layout === "compact"}
          />

          {/* Password section — visible while showPassword is true */}
          {passwordSupported && showPassword ? (
            <div id={passwordSectionId} className="flex flex-col gap-3">
              {/* Visible, persistent label — an accessible name that survives
                  typing (a placeholder disappears on input and leaves screen-
                  reader + low-vision users without the field's purpose). */}
              <label
                htmlFor="password-input"
                className="text-sm font-semibold text-nq-foreground"
              >
                {t.passwordLabel}
              </label>
              <Input
                id="password-input"
                type="password"
                autoComplete={
                  mode === "register" ? "new-password" : "current-password"
                }
                placeholder={t.passwordPlaceholder}
                className="text-base min-h-[48px]"
                value={password}
                onChange={(ev) => {
                  setPassword(ev.target.value);
                  if (error) setError(null);
                }}
                aria-invalid={Boolean(error)}
                error={Boolean(error)}
              />
              {password ? (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-nq-border rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all ${
                          passwordStrength === "strong"
                            ? "bg-green-500 w-full"
                            : passwordStrength === "medium"
                              ? "bg-yellow-500 w-2/3"
                              : "bg-red-500 w-1/3"
                        }`}
                      />
                    </div>
                    <span
                      className={`text-xs font-medium ${
                        passwordStrength === "strong"
                          ? "text-green-600"
                          : passwordStrength === "medium"
                            ? "text-yellow-600"
                            : "text-red-600"
                      }`}
                    >
                      {passwordStrength === "strong"
                        ? t.passwordStrengthStrong
                        : passwordStrength === "medium"
                          ? t.passwordStrengthMedium
                          : t.passwordStrengthWeak}
                    </span>
                  </div>
                  <p className="text-xs text-nq-muted">{t.passwordRequirements}</p>
                </div>
              ) : null}
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  data-testid={`password-${primaryPasswordAction}-submit`}
                  variant="primary"
                  size="md"
                  className="w-full min-h-[48px] text-base"
                  loading={pending && pendingAction === primaryPasswordAction}
                  disabled={
                    !isHydrated ||
                    pending ||
                    (primaryPasswordAction === "signup" &&
                      !isPasswordAcceptable)
                  }
                  onClick={() => onPasswordSubmit(primaryPasswordAction)}
                >
                  {passwordActionLabel(
                    primaryPasswordAction,
                    primaryPasswordLabel,
                  )}
                </Button>
                <Button
                  type="button"
                  data-testid={`password-${secondaryPasswordAction}-submit`}
                  variant="secondary"
                  size="md"
                  className="w-full min-h-[48px] text-base"
                  loading={pending && pendingAction === secondaryPasswordAction}
                  disabled={
                    !isHydrated ||
                    pending ||
                    (secondaryPasswordAction === "signup" &&
                      !isPasswordAcceptable)
                  }
                  onClick={() => onPasswordSubmit(secondaryPasswordAction)}
                >
                  {passwordActionLabel(
                    secondaryPasswordAction,
                    secondaryPasswordLabel,
                  )}
                </Button>
              </div>
              {/* Magic-link as "forgot password" fallback */}
              <form onSubmit={onMagicLink} method="post">
                <button
                  type="submit"
                  disabled={!isHydrated || pending}
                  className="w-full min-h-[44px] text-sm text-nq-muted underline-offset-4 transition hover:text-nq-foreground hover:underline disabled:opacity-50"
                >
                  {pending && pendingAction === "magic" ? "…" : t.forgotPasswordLinkText}
                </button>
              </form>
            </div>
          ) : (
            /* Magic-link mode: either compact layout, or password form was dismissed */
            <>
              <form onSubmit={onMagicLink} method="post">
                <Button
                  type="submit"
                  variant={layout === "open" ? "secondary" : "ghost"}
                  size="md"
                  className="w-full min-h-[48px]"
                  loading={pending && pendingAction === "magic"}
                  disabled={!isHydrated || pending}
                >
                  {magicLinkButtonLabel}
                </Button>
              </form>
              {/* When user switched from password mode, offer a way back */}
              {passwordSupported ? (
                <button
                  type="button"
                  disabled={!isHydrated}
                  onClick={() => {
                    setShowPassword(true);
                    setError(null);
                    setPassword("");
                  }}
                  className="self-center text-sm text-nq-muted underline-offset-4 transition hover:text-nq-foreground hover:underline"
                >
                  {t.showPasswordToggle}
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {error ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-nq-error dark:bg-red-950/30" role="alert">
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
