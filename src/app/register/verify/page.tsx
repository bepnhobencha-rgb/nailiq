"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import { cn } from "@/shared/lib/cn";
import { isPublicDemoOtpMode } from "@/shared/lib/demoOtpMode";
import { REG_SESSION_PHONE_DIGITS_KEY } from "@/shared/lib/registerSessionKeys";
import { createClient as createBrowserSupabase } from "@/shared/lib/supabase/client";
import { verifyDemoRegisterOtp } from "@/shared/register/actions";
import {
  digitsToE164Phone,
  isRegisterPhoneDigitsValid,
  normalizeRegisterPhone,
} from "@/shared/register/phone";

const OTP_LEN = 6;

function emptyDigits(): string[] {
  return Array.from({ length: OTP_LEN }, () => "");
}

export default function RegisterVerifyPage() {
  const router = useRouter();
  const [digits, setDigits] = useState(emptyDigits);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [phoneDigits, setPhoneDigits] = useState<string | null>(null);
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const demoMode = isPublicDemoOtpMode();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const fromSession = window.sessionStorage.getItem(
      REG_SESSION_PHONE_DIGITS_KEY,
    );
    if (!fromSession || !isRegisterPhoneDigitsValid(fromSession)) {
      router.replace("/register");
      return;
    }
    setPhoneDigits(fromSession);
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
      const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, OTP_LEN);
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
          const result = await verifyDemoRegisterOtp(phoneDigits, codeJoined);
          if (!result.ok) {
            if (result.reason === "expired") {
              setError("Code expired — request a new one.");
            } else if (result.reason === "server_error") {
              setError(
                "We could not open your session. Check SUPABASE_SERVICE_ROLE_KEY and migrations.",
              );
            } else {
              setError("Invalid code.");
            }
            return;
          }
          router.push("/register/setup");
          return;
        }

        const e164 = digitsToE164Phone(phoneDigits);
        if (!e164) {
          setError("Invalid phone session. Start again.");
          router.replace("/register");
          return;
        }

        const supabase = createBrowserSupabase();
        const { error: vErr } = await supabase.auth.verifyOtp({
          phone: e164,
          token: codeJoined,
          type: "sms",
        });

        if (vErr) {
          setError(vErr.message || "Invalid or expired code.");
          return;
        }

        router.push("/register/setup");
      });
    },
    [codeJoined, demoMode, phoneDigits, router],
  );

  return (
    <RegisterStepShell
      title="Enter code"
      subtext="We sent a 6-digit code to your number."
    >
      {demoMode ? (
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <Badge variant="muted" className="uppercase tracking-[0.14em]">
            DEMO MODE
          </Badge>
          <span className="text-xs text-nq-muted">
            Use the code from the demo modal or server log.
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
