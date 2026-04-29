"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import { cn } from "@/shared/lib/cn";
import {
  REG_COMPLETION_TOKEN_KEY,
  REG_FLOW_OWNER_RETURNING,
  REG_SESSION_PHONE_DIGITS_KEY,
} from "@/shared/lib/registerSessionKeys";
import {
  finalizeRegisterSessionAfterPhoneOtp,
  verifyRegisterOtp,
} from "@/shared/register/actions";
import { digitsToE164Phone } from "@/shared/register/phone";
import { createClient as createBrowserSupabaseClient } from "@/shared/lib/supabase/client";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { isRegisterPhoneDigitsValid } from "@/shared/register/phone";

const OTP_LEN = 6;

function emptyDigits(): string[] {
  return Array.from({ length: OTP_LEN }, () => "");
}

type Props = { demoMode: boolean };

export function VerifyPageClient({ demoMode }: Props) {
  const router = useRouter();
  const { language } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language), [language]);
  const [digits, setDigits] = useState(emptyDigits);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [phoneDigits, setPhoneDigits] = useState<string | null>(null);
  const [isReturningFlow, setIsReturningFlow] = useState(false);
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const verifySubtext = useMemo(
    () =>
      isReturningFlow
        ? t.register.welcomeBackVerifySubtext
        : "We sent a 6-digit code to your number.",
    [isReturningFlow, t.register.welcomeBackVerifySubtext],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const returning =
      sessionStorage.getItem(REG_FLOW_OWNER_RETURNING) === "1";
    queueMicrotask(() => setIsReturningFlow(returning));

    const fromSession = window.sessionStorage.getItem(
      REG_SESSION_PHONE_DIGITS_KEY,
    );
    if (!fromSession || !isRegisterPhoneDigitsValid(fromSession)) {
      router.replace("/register");
      return;
    }
    queueMicrotask(() => setPhoneDigits(fromSession));
  }, [router]);

  const focusAt = useCallback((i: number) => {
    refs.current[i]?.focus();
    refs.current[i]?.select();
  }, []);

  const onDigitChange = useCallback(
    (index: number, raw: string) => {
      const d = raw.replace(/\D/g, "").slice(-1);
      setDigits((prev) => {
        const next = [...prev];
        next[index] = d;
        return next;
      });
      setError(null);
      if (d && index < OTP_LEN - 1) {
        requestAnimationFrame(() => focusAt(index + 1));
      }
    },
    [focusAt],
  );

  const onKeyDown = useCallback(
    (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Backspace") return;
      const empty =
        !(e.target as HTMLInputElement).value ||
        (e.target as HTMLInputElement).value === "";
      if (empty && index > 0) {
        e.preventDefault();
        setDigits((prev) => {
          const next = [...prev];
          next[index - 1] = "";
          return next;
        });
        focusAt(index - 1);
      }
    },
    [focusAt],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const pasted = e.clipboardData
        .getData("text")
        .replace(/\D/g, "")
        .slice(0, OTP_LEN);
      if (pasted.length !== OTP_LEN) return;
      e.preventDefault();
      setDigits(pasted.split(""));
      setError(null);
      focusAt(OTP_LEN - 1);
    },
    [focusAt],
  );

  const codeJoined = digits.join("");

  const onSubmit = useCallback(
    (ev: React.FormEvent) => {
      ev.preventDefault();
      if (codeJoined.length !== OTP_LEN || !phoneDigits) return;
      setError(null);
      startTransition(async () => {
        if (demoMode) {
          const result = await verifyRegisterOtp(phoneDigits, codeJoined);

          if (!result.ok) {
            if (result.reason === "expired") {
              setError("Code expired — request a new one.");
            } else if (result.reason === "server_error") {
              setError(
                "We could not verify your code. Check SUPABASE_SERVICE_ROLE_KEY and migrations.",
              );
            } else {
              setError("Invalid code.");
            }
            return;
          }

          if (typeof window !== "undefined") {
            window.sessionStorage.removeItem(REG_FLOW_OWNER_RETURNING);
          }

          if ("returningOwnerSlug" in result) {
            router.push(
              `/dashboard/${encodeURIComponent(result.returningOwnerSlug)}`,
            );
            return;
          }

          const ct = result.completionToken.trim();
          if (!ct) {
            setError("Missing completion token. Try again.");
            return;
          }
          if (typeof window !== "undefined") {
            window.sessionStorage.setItem(REG_COMPLETION_TOKEN_KEY, ct);
          }

          window.location.assign("/register/setup");
          return;
        }

        const supabase = createBrowserSupabaseClient();
        const e164 = digitsToE164Phone(phoneDigits);
        if (!e164) {
          setError(
            "Enter 8–15 digits including country code (e.g. Vietnam: 84912345678).",
          );
          return;
        }

        const { error: otpErr } = await supabase.auth.verifyOtp({
          phone: e164,
          token: codeJoined,
          type: "sms",
        });

        if (otpErr) {
          console.error("[VerifyPageClient] verifyOtp", otpErr);
          const msg = otpErr.message?.toLowerCase() ?? "";
          if (msg.includes("expired")) {
            setError("Code expired — request a new one.");
          } else {
            setError("Invalid code.");
          }
          return;
        }

        await supabase.auth.getSession();

        const finalize = await finalizeRegisterSessionAfterPhoneOtp(phoneDigits);

        if (!finalize.ok) {
          if (finalize.reason === "unauthorized") {
            setError(
              "Could not establish your session after SMS. Try again or refresh the page.",
            );
          } else {
            setError("We could not complete sign-in. Try again.");
          }
          return;
        }

        if (typeof window !== "undefined") {
          window.sessionStorage.removeItem(REG_FLOW_OWNER_RETURNING);
        }

        if (finalize.kind === "dashboard") {
          window.location.assign(
            `/dashboard/${encodeURIComponent(finalize.slug)}`,
          );
          return;
        }

        window.sessionStorage.setItem(
          REG_COMPLETION_TOKEN_KEY,
          finalize.completionToken,
        );
        window.location.assign("/register/setup");
      });
    },
    [codeJoined, demoMode, phoneDigits],
  );

  return (
    <RegisterStepShell title="Enter code" subtext={verifySubtext}>
      {demoMode ? (
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <Badge variant="muted" className="uppercase tracking-[0.14em]">
            {isReturningFlow ? "Returning" : "Demo mode"}
          </Badge>
          <span className="text-xs text-nq-muted">
            {isReturningFlow
              ? t.register.welcomeBackAfterSend
              : "Use the code from the demo modal or server log."}
          </span>
        </div>
      ) : null}

      <form onSubmit={onSubmit} className="flex flex-col gap-6">
        <div className="grid grid-cols-6 gap-2 sm:gap-3">
          {digits.map((digit, i) => (
            <input
              key={i}
              ref={(el) => {
                refs.current[i] = el;
              }}
              inputMode="numeric"
              autoComplete={i === 0 ? "one-time-code" : "off"}
              maxLength={1}
              value={digit}
              aria-label={`Digit ${i + 1}`}
              onPaste={i === 0 ? onPaste : undefined}
              onChange={(e) => onDigitChange(i, e.target.value)}
              onKeyDown={(e) => onKeyDown(i, e)}
              className={cn(
                "flex h-[52px] min-h-[52px] w-full items-center justify-center rounded-2xl border bg-nq-surface text-center font-mono text-base tracking-[0.08em] text-nq-foreground outline-none transition-all duration-200",
                "border-nq-border focus:border-nq-primary focus:shadow-[0_0_0_2px_rgba(212,175,55,0.35)] focus:ring-2 focus:ring-nq-primary/40 focus:ring-offset-2 focus:ring-offset-nq-bg",
                error &&
                  "border-nq-error focus:border-nq-error focus:shadow-none focus:ring-nq-error/35",
              )}
            />
          ))}
        </div>

        {phoneDigits ? (
          <p className="text-center text-xs text-nq-muted">
            Number ending in ····{phoneDigits.slice(-4)} — enter all 6 digits of
            the code.
          </p>
        ) : null}

        {error ? (
          <p className="text-center text-sm text-nq-error" role="status">
            {error}
          </p>
        ) : null}

        <Button
          type="submit"
          size="lg"
          className="w-full min-h-11"
          disabled={codeJoined.length !== OTP_LEN || pending || !phoneDigits}
        >
          {pending ? "Checking…" : "Continue"}
        </Button>

        <button
          type="button"
          className="min-h-11 text-center text-sm text-nq-primary-soft underline decoration-nq-primary/35 underline-offset-2 transition-opacity duration-150 hover:opacity-90"
          onClick={() => router.push("/register")}
        >
          Use a different number
        </button>
      </form>
    </RegisterStepShell>
  );
}
