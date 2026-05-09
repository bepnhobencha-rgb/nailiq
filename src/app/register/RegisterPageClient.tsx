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
import { sendRegisterOtp } from "@/shared/register/actions";
import {
  isRegisterPhoneDigitsValid,
  normalizeRegisterPhone,
} from "@/shared/register/phone";

type Props = { demoMode: boolean };

/** `idle` = before Send code; distinguishes returning owner vs net-new OTP tone after send */
type PostSendTone = "idle" | "returning" | "new";

export function RegisterPageClient({ demoMode }: Props) {
  const router = useRouter();
  const { language } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language), [language]);
  const [phoneRaw, setPhoneRaw] = useState("+1 ");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [demoCode, setDemoCode] = useState<string | null>(null);
  const [postSendTone, setPostSendTone] = useState<PostSendTone>("idle");
  const [toast, setToast] = useState<SetupToastPayload | null>(null);

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const normalized = normalizeRegisterPhone(phoneRaw);
      if (!isRegisterPhoneDigitsValid(normalized)) {
        setError(t.register.phoneDigitsInvalid);
        return;
      }
      setError(null);
      startTransition(async () => {
        // Detect a resend: phone-digits already in sessionStorage means a
        // prior `sendRegisterOtp` succeeded earlier in this tab.
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
          setError(result.error);
          return;
        }

        if (typeof window !== "undefined") {
          window.sessionStorage.setItem(
            REG_SESSION_PHONE_DIGITS_KEY,
            normalized,
          );
          if (result.mode === "returning") {
            window.sessionStorage.setItem(REG_FLOW_OWNER_RETURNING, "1");
          } else {
            window.sessionStorage.removeItem(REG_FLOW_OWNER_RETURNING);
          }
          if (isResend) {
            // Picked up by VerifyPageClient on the next mount.
            window.sessionStorage.setItem(REG_OTP_RESENT_FLAG, "1");
          }
        }

        if (isResend) {
          setToast({
            variant: "success",
            message: t.register.otpResentToast,
          });
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

  const demoBadgeLabel =
    postSendTone === "returning"
      ? t.register.demoBadgeReturning
      : t.register.demoBadgeNew;

  const demoBadgeCaption =
    postSendTone === "returning"
      ? t.register.welcomeBackAfterSend
      : t.register.newDemoOtpBadgeNote;

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
        onSubmit={onSubmit}
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
              if (error) setError(null);
            }}
            aria-invalid={Boolean(error)}
            error={Boolean(error)}
            autoFocus
          />
          {error ? (
            <p className="mt-2 text-sm text-nq-error" role="status">
              {error}
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
