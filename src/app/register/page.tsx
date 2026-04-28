"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { DemoOtpModal } from "@/components/register/DemoOtpModal";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import { isPublicDemoOtpMode } from "@/shared/lib/demoOtpMode";
import { REG_SESSION_PHONE_DIGITS_KEY } from "@/shared/lib/registerSessionKeys";
import { createClient as createBrowserSupabase } from "@/shared/lib/supabase/client";
import { sendRegisterOtp } from "@/shared/register/actions";
import {
  digitsToE164Phone,
  isRegisterPhoneDigitsValid,
  normalizeRegisterPhone,
} from "@/shared/register/phone";

export default function RegisterPage() {
  const router = useRouter();
  const [phoneRaw, setPhoneRaw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [demoCode, setDemoCode] = useState<string | null>(null);
  const demoMode = isPublicDemoOtpMode();

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
        if (typeof window !== "undefined") {
          window.sessionStorage.setItem(REG_SESSION_PHONE_DIGITS_KEY, normalized);
        }

        if (demoMode) {
          const result = await sendRegisterOtp(normalized);
          if (!result.success) {
            setError(result.error);
            return;
          }
          setDemoCode(result.demoCode);
          return;
        }

        const e164 = digitsToE164Phone(normalized);
        if (!e164) {
          setError(
            "Enter 8–15 digits including country code (e.g. Vietnam: 84912345678).",
          );
          return;
        }

        const supabase = createBrowserSupabase();
        const { error: otpError } = await supabase.auth.signInWithOtp({
          phone: e164,
          options: { shouldCreateUser: true },
        });

        if (otpError) {
          setError(
            otpError.message ||
              "Could not send SMS. Enable Phone auth in Supabase or use demo mode.",
          );
          return;
        }

        router.push("/register/verify");
      });
    },
    [demoMode, phoneRaw, router],
  );

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
            DEMO MODE
          </Badge>
          <span className="text-xs leading-snug text-nq-muted">
            OTP appears in a secure modal after you send the code.
          </span>
        </div>
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
