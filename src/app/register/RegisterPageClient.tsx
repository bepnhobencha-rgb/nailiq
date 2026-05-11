"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useMemo,
  useState,
  useTransition,
} from "react";
import { SocialAuthButtons } from "@/components/auth/SocialAuthButtons";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Toast, type SetupToastPayload } from "@/components/ui/Toast";
import { DemoOtpModal } from "@/components/register/DemoOtpModal";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import { getUserMessages } from "@/shared/i18n/user";
import {
  REG_FLOW_OWNER_RETURNING,
  REG_OTP_RESENT_FLAG,
  REG_SESSION_PHONE_DIGITS_KEY,
} from "@/shared/lib/registerSessionKeys";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { sendRegisterOtp, sendEmailMagicLink } from "@/shared/register/actions";
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

/** `idle` = before Send code; distinguishes returning owner vs net-new OTP tone after send */
type PostSendTone = "idle" | "returning" | "new";

export function RegisterPageClient({ demoMode, smsEnabled, emailEnabled }: Props) {
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
  const [postSendTone, setPostSendTone] = useState<PostSendTone>("idle");
  const [toast, setToast] = useState<SetupToastPayload | null>(null);

  // Determine which mode to render
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
        const isResend =
          typeof window !== "undefined" &&
          window.sessionStorage.getItem(REG_SESSION_PHONE_DIGITS_KEY) !== null;

        if (
          process.env.NODE_ENV === "development" ||
          process.env.NEXT_PUBLIC_DEBUG_REGISTER_FLOW === "1"
        ) {
          console.log("Form submitted with phone:", normalized);
        }
        const result = await sendRegisterOtp(normalized);
        if (!result.success) {
          setPhoneError(result.error);
          return;
        }

        if (typeof window !== "undefined") {
          window.sessionStorage.setItem(REG_SESSION_PHONE_DIGITS_KEY, normalized);
          if (result.mode === "returning") {
            window.sessionStorage.setItem(REG_FLOW_OWNER_RETURNING, "1");
          } else {
            window.sessionStorage.removeItem(REG_FLOW_OWNER_RETURNING);
          }
          if (isResend) {
            window.sessionStorage.setItem(REG_OTP_RESENT_FLAG, "1");
          }
        }

        if (isResend) {
          setToast({ variant: "success", message: t.register.otpResentToast });
        }

        const isReturning = result.mode === "returning";
        setPostSendTone(isReturning ? "returning" : "new");

        if (result.mode === "returning") {
          if (result.code) {
            setDemoCode(result.code);
            return;
          }
          router.push("/register/verify");
          return;
        }

        if (result.mode === "demo") {
          setDemoCode(result.code);
          return;
        }

        router.push("/register/verify");
      });
    },
    [phoneRaw, router, t.register.otpResentToast, t.register.phoneDigitsInvalid],
  );

  // ── Email submit ──────────────────────────────────────────────────────────
  const onEmailSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const email = emailRaw.trim().toLowerCase();
      if (!email || !email.includes("@") || email.length > 254) {
        setEmailError(t.register.emailInvalid);
        return;
      }
      setEmailError(null);
      startTransition(async () => {
        const result = await sendEmailMagicLink(email);
        if (!result.success) {
          setEmailError(result.error);
          return;
        }
        // Show "check your email" confirmation in place of the form.
        setEmailSentTo(email);
      });
    },
    [emailRaw, t.register.emailInvalid],
  );

  const demoBadgeLabel =
    postSendTone === "returning"
      ? t.register.demoBadgeReturning
      : t.register.demoBadgeNew;

  const demoBadgeCaption =
    postSendTone === "returning"
      ? t.register.welcomeBackAfterSend
      : t.register.newDemoOtpBadgeNote;

  // ── Registration disabled ─────────────────────────────────────────────────
  if (bothDisabled) {
    return (
      <RegisterStepShell
        title={t.register.registrationDisabledTitle}
        subtext={t.register.registrationDisabledBody}
      />
    );
  }

  // ── Email magic-link path ─────────────────────────────────────────────────
  if (useEmailPath) {
    // After the magic link is dispatched, replace the form with a confirmation.
    if (emailSentTo) {
      return (
        <RegisterStepShell
          title={t.register.emailLinkSentTitle}
          subtext={t.register.emailLinkSentBody.replace("{email}", emailSentTo)}
        >
          <p className="mt-4 text-center text-xs text-nq-muted">
            {t.register.returningOwnerHint}
          </p>
          <button
            type="button"
            className="mt-3 w-full min-h-11 text-center text-sm text-nq-primary-soft underline decoration-nq-primary/35 underline-offset-2 transition-opacity duration-150 hover:opacity-90"
            onClick={() => {
              setEmailSentTo(null);
              setEmailRaw("");
            }}
          >
            {t.register.verifyUseDifferentNumber}
          </button>
        </RegisterStepShell>
      );
    }

    return (
      <RegisterStepShell
        title={t.register.emailEntryTitle}
        subtext={t.register.emailAuthSubtext}
      >
        <Toast toast={toast} onDismiss={() => setToast(null)} />

        <p className="mb-2 text-sm text-nq-muted sm:mb-4">
          {t.register.returningOwnerHint}
        </p>

        <form onSubmit={onEmailSubmit} method="post" className="flex flex-col gap-6">
          <div>
            <Input
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder={t.register.emailPlaceholder}
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
            {pending ? t.register.sendingEmailLink : t.register.sendEmailLink}
          </Button>
        </form>

        <SocialAuthButtons mode="register" />
      </RegisterStepShell>
    );
  }

  // ── Default SMS / phone-OTP path ──────────────────────────────────────────
  return (
    <RegisterStepShell
      title={t.register.phoneEntryTitle}
      subtext={
        demoMode ? t.register.phoneAuthDemoSubtext : t.register.phoneAuthSubtext
      }
      helperHint={demoMode ? t.register.phoneAuthDemoHelperHint : undefined}
    >
      {demoMode ? (
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <Badge variant="default" className="uppercase tracking-[0.14em]">
            {demoBadgeLabel}
          </Badge>
          <span className="text-xs leading-snug text-nq-muted">
            {postSendTone === "idle"
              ? t.register.newDemoOtpBadgeNote
              : demoBadgeCaption}
          </span>
        </div>
      ) : postSendTone === "returning" ? (
        <p
          className="mb-4 rounded-2xl border border-nq-primary/35 bg-nq-primary/[0.07] px-4 py-3 text-center text-sm leading-snug text-nq-foreground"
          role="status"
        >
          {t.register.welcomeBackAfterSend}
        </p>
      ) : null}

      <DemoOtpModal
        code={demoCode ?? ""}
        open={Boolean(demoCode)}
        onDismiss={() => setDemoCode(null)}
        onContinue={() => {
          setDemoCode(null);
          router.push("/register/verify");
        }}
      />

      <Toast toast={toast} onDismiss={() => setToast(null)} />

      <p className="mb-2 text-sm text-nq-muted sm:mb-4">
        {t.register.returningOwnerHint}
      </p>

      <form
        onSubmit={onPhoneSubmit}
        method="post"
        className="flex flex-col gap-6"
      >
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
          {pending ? t.register.sendingCode : t.register.sendCode}
        </Button>
      </form>

      {demoMode ? null : <SocialAuthButtons mode="register" />}
    </RegisterStepShell>
  );
}
