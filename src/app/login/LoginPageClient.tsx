"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";
import { SocialAuthButtons } from "@/components/auth/SocialAuthButtons";
import { DemoOtpModal } from "@/components/register/DemoOtpModal";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { getUserMessages } from "@/shared/i18n/user";
import {
  REG_FLOW_OWNER_RETURNING,
  REG_SESSION_PHONE_DIGITS_KEY,
} from "@/shared/lib/registerSessionKeys";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { sendLoginOtp } from "@/shared/register/actions";
import {
  isRegisterPhoneDigitsValid,
  normalizeRegisterPhone,
} from "@/shared/register/phone";

type Props = {
  demoMode: boolean;
  /** When false the SMS path is bypassed — check emailEnabled for fallback. */
  smsEnabled: boolean;
  /** When true (and smsEnabled=false), show the email magic-link input. */
  emailEnabled: boolean;
  /** Shown when the proxy bounced an unconfirmed-email session here. */
  showConfirmEmailNotice?: boolean;
};

export function LoginPageClient({
  demoMode,
  smsEnabled,
  emailEnabled,
  showConfirmEmailNotice = false,
}: Props) {
  const router = useRouter();
  const { language } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language), [language]);

  // Phone state (SMS path)
  const [phoneRaw, setPhoneRaw] = useState("+1 ");
  const [phoneError, setPhoneError] = useState<string | null>(null);

  const [pending, startTransition] = useTransition();
  const [demoCode, setDemoCode] = useState<string | null>(null);

  // Determine which branch to render. Same precedence as /register so
  // both flows behave consistently under the platform_flags toggle:
  //   sms_enabled=true        → phone OTP form (legacy default)
  //   email_enabled=true only → email magic-link
  //   neither                 → "sign-in temporarily unavailable" panel
  const useEmailPath = !demoMode && !smsEnabled && emailEnabled;
  const bothDisabled = !demoMode && !smsEnabled && !emailEnabled;

  // Banner rendered when the proxy redirected an unconfirmed-email
  // session to /login?notice=confirm-email. Shown across whichever
  // sign-in branch the platform flags select.
  const confirmEmailBanner = showConfirmEmailNotice ? (
    <div
      role="status"
      className="mb-4 rounded-lg border border-nq-primary/30 bg-nq-primary/10 px-4 py-3 text-sm text-nq-primary-soft"
    >
      {t.login.confirmEmailNotice}
    </div>
  ) : null;

  // ── SMS submit ────────────────────────────────────────────────────────────
  const onPhoneSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const normalized = normalizeRegisterPhone(phoneRaw);
      if (!isRegisterPhoneDigitsValid(normalized)) {
        setPhoneError(t.register.phoneDigitsInvalid);
        return;
      }
      setPhoneError(null);
      startTransition(async () => {
        // sendLoginOtp pre-checks salon ownership; rejects unknown phones
        // BEFORE sending SMS (saves cost in prod, faster feedback in dev).
        let result: Awaited<ReturnType<typeof sendLoginOtp>>;
        try {
          result = await sendLoginOtp(normalized);
        } catch {
          // Network-level fetch failure (iOS Safari: "Load failed") —
          // surface a retryable message instead of an unhandled rejection.
          setPhoneError(t.login.errorNetwork);
          return;
        }

        if (!result.success) {
          setPhoneError(result.error);
          return;
        }

        if (typeof window !== "undefined") {
          window.sessionStorage.setItem(
            REG_SESSION_PHONE_DIGITS_KEY,
            normalized,
          );
          window.sessionStorage.setItem(REG_FLOW_OWNER_RETURNING, "1");
        }

        if (result.mode !== "email_link" && result.code) {
          setDemoCode(result.code);
          return;
        }
        router.push("/login/verify");
      });
    },
    [phoneRaw, router, t.login.errorNetwork, t.register.phoneDigitsInvalid],
  );

  // ── Branch 3: sign-in temporarily unavailable ─────────────────────────────
  if (bothDisabled) {
    return (
      <RegisterStepShell
        title={t.login.signinDisabledTitle}
        subtext={t.login.signinDisabledBody}
      />
    );
  }

  // ── Branch 2: email path — Google primary, password default, magic link fallback ──
  if (useEmailPath) {
    return (
      <RegisterStepShell
        title={t.login.emailEntryTitle}
        subtext={t.login.subtextEmail}
      >
        {confirmEmailBanner}
        <SocialAuthButtons mode="login" layout="open" enablePassword={true} />
        <p className="mt-6 text-center text-sm text-nq-muted">
          {t.login.noSalonPrefix}
          <Link
            href="/register"
            className="font-medium text-nq-primary hover:underline"
          >
            {t.login.signupLink}
          </Link>
        </p>
      </RegisterStepShell>
    );
  }

  // ── Branch 1: default SMS / phone-OTP path (unchanged behaviour) ──────────
  return (
    <RegisterStepShell
      title={t.login.title}
      subtext={demoMode ? t.login.subtextDemo : t.login.subtextSms}
    >
      <DemoOtpModal
        code={demoCode ?? ""}
        open={Boolean(demoCode)}
        onDismiss={() => setDemoCode(null)}
        onContinue={() => {
          setDemoCode(null);
          router.push("/login/verify");
        }}
      />

      {confirmEmailBanner}

      <p className="mb-2 text-sm text-nq-muted sm:mb-4">
        {t.login.promptEnterPhone}
      </p>

      <form onSubmit={onPhoneSubmit} method="post" className="flex flex-col gap-6">
        <div>
          <Input
            suppressHydrationWarning
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder={t.register.phonePlaceholder}
            className="text-base"
            value={phoneRaw}
            onChange={(ev) => {
              setPhoneRaw(ev.target.value);
              if (phoneError) setPhoneError(null);
            }}
            onBlur={() => {
              const trimmed = phoneRaw.trim();
              if (trimmed.length === 0) return;
              const normalized = normalizeRegisterPhone(trimmed);
              if (!isRegisterPhoneDigitsValid(normalized)) {
                setPhoneError(t.register.phoneDigitsInvalid);
              }
            }}
            aria-invalid={Boolean(phoneError)}
            error={Boolean(phoneError)}
            autoFocus
          />
          {phoneError ? (
            <p className="mt-2 text-sm text-nq-error" role="status">
              {phoneError}
            </p>
          ) : null}
        </div>
        <Button
          type="submit"
          size="lg"
          className="w-full min-h-11"
          disabled={pending}
        >
          {pending ? t.login.sendingCode : t.login.sendCode}
        </Button>

        <p className="text-center text-sm text-nq-muted">
          <Link
            href="/login/forgot-password"
            className="font-medium text-nq-primary hover:underline"
          >
            {t.login.forgotPasswordLink}
          </Link>
        </p>
      </form>

      {demoMode ? null : <SocialAuthButtons mode="login" />}

      <p className="mt-6 text-center text-sm text-nq-muted">
        {t.login.noSalonPrefix}
        <Link
          href="/register"
          className="font-medium text-nq-primary hover:underline"
        >
          {t.login.signupLink}
        </Link>
      </p>
    </RegisterStepShell>
  );
}
