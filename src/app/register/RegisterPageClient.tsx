"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useMemo,
  useState,
  useTransition,
} from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { DemoOtpModal } from "@/components/register/DemoOtpModal";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import { getUserMessages } from "@/shared/i18n/user";
import {
  REG_FLOW_OWNER_RETURNING,
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
  const [phoneRaw, setPhoneRaw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [demoCode, setDemoCode] = useState<string | null>(null);
  const [postSendTone, setPostSendTone] = useState<PostSendTone>("idle");

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const normalized = normalizeRegisterPhone(phoneRaw);
      if (!isRegisterPhoneDigitsValid(normalized)) {
        setError(
          "Enter 8–15 digits including country code (e.g. Vietnam: 84912345678).",
        );
        return;
      }
      setError(null);
      startTransition(async () => {
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
        }

        const isReturning = result.mode === "returning";
        setPostSendTone(isReturning ? "returning" : "new");

        if (result.mode === "returning") {
          if (result.demoCode) {
            setDemoCode(result.demoCode);
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
    [phoneRaw, router],
  );

  const demoBadgeLabel =
    postSendTone === "returning" ? "Returning" : "Demo mode";

  const demoBadgeCaption =
    postSendTone === "returning"
      ? t.register.welcomeBackAfterSend
      : t.register.newDemoOtpBadgeNote;

  return (
    <RegisterStepShell
      title="Verify your number"
      subtext={
        demoMode
          ? "Demo mode shows the OTP on screen. Production uses SMS from Supabase."
          : "We’ll text you a one-time code. Enable Phone Auth in Supabase (Auth → Providers → Phone)."
      }
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

      <p className="mb-2 text-sm text-nq-muted sm:mb-4">
        {t.register.returningOwnerHint}
      </p>

      <form onSubmit={onSubmit} className="flex flex-col gap-6">
        <div>
          <Input
            suppressHydrationWarning
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="Mobile number"
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
          {pending ? "Sending…" : "Send code"}
        </Button>
      </form>
    </RegisterStepShell>
  );
}
