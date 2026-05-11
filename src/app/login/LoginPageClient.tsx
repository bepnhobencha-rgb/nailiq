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
import { sendEmailMagicLink, sendLoginOtp } from "@/shared/register/actions";
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
};

export function LoginPageClient({
  demoMode,
  smsEnabled,
  emailEnabled,
}: Props) {
  const router = useRouter();
  const { language } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language), [language]);

  // Phone state (SMS path)
  const [phoneRaw, setPhoneRaw] = useState("+1 ");
  const [phoneError, setPhoneError] = useState<string | null>(null);

  // Email state (magic-link path)
  const [emailRaw, setEmailRaw] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailSentTo, setEmailSentTo] = useState<string | null>(null);

  const [pending, startTransition] = useTransition();
  const [demoCode, setDemoCode] = useState<string | null>(null);

  // Determine which branch to render. Same precedence as /register so
  // both flows behave consistently under the platform_flags toggle:
  //   sms_enabled=true        → phone OTP form (legacy default)
  //   email_enabled=true only → email magic-link
  //   neither                 → "sign-in temporarily unavailable" panel
  const useEmailPath = !demoMode && !smsEnabled && emailEnabled;
  const bothDisabled = !demoMode && !smsEnabled && !emailEnabled;

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
        const result = await sendLoginOtp(normalized);

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
    [phoneRaw, router, t.register.phoneDigitsInvalid],
  );

  // ── Email submit ──────────────────────────────────────────────────────────
  const onEmailSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const email = emailRaw.trim().toLowerCase();
      if (!email || !email.includes("@") || email.length > 254) {
        setEmailError(t.login.emailInvalid);
        return;
      }
      setEmailError(null);
      startTransition(async () => {
        const result = await sendEmailMagicLink(email);
        if (!result.success) {
          setEmailError(result.error);
          return;
        }
        setEmailSentTo(email);
      });
    },
    [emailRaw, t.login.emailInvalid],
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

  // ── Branch 2: email magic-link path ───────────────────────────────────────
  if (useEmailPath) {
    if (emailSentTo) {
      return (
        <RegisterStepShell
          title={t.login.emailLinkSentTitle}
          subtext={t.login.emailLinkSentBody.replace("{email}", emailSentTo)}
        >
          <button
            type="button"
            className="mt-3 w-full min-h-11 text-center text-sm text-nq-primary-soft underline decoration-nq-primary/35 underline-offset-2 transition-opacity duration-150 hover:opacity-90"
            onClick={() => {
              setEmailSentTo(null);
              setEmailRaw("");
            }}
          >
            {t.login.emailLinkUseDifferent}
          </button>
        </RegisterStepShell>
      );
    }

    return (
      <RegisterStepShell
        title={t.login.emailEntryTitle}
        subtext={t.login.subtextEmail}
      >
        <form
          onSubmit={onEmailSubmit}
          method="post"
          className="flex flex-col gap-6"
        >
          <div>
            <Input
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder={t.login.emailPlaceholder}
              className="text-base"
              value={emailRaw}
              onChange={(ev) => {
                setEmailRaw(ev.target.value);
                if (emailError) setEmailError(null);
              }}
              aria-invalid={Boolean(emailError)}
              error={Boolean(emailError)}
              autoFocus
            />
            {emailError ? (
              <p className="mt-2 text-sm text-nq-error" role="status">
                {emailError}
              </p>
            ) : null}
          </div>
          <Button
            type="submit"
            size="lg"
            className="w-full min-h-11"
            loading={pending}
            disabled={pending}
          >
            {pending ? t.login.sendingSigninLink : t.login.sendSigninLink}
          </Button>
        </form>

        <SocialAuthButtons mode="login" />

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
