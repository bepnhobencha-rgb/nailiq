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
import {
  getRegisterFlow,
  setRegisterCompletionCookie,
  setRegisterFlow,
} from "@/shared/lib/registerFlow";
import { verifyRegisterOtp } from "@/shared/register/actions";

const OTP_LEN = 6;

function emptyDigits(): string[] {
  return Array.from({ length: OTP_LEN }, () => "");
}

export default function RegisterVerifyPage() {
  const router = useRouter();
  const [digits, setDigits] = useState(emptyDigits);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    const flow = getRegisterFlow();
    if (!flow.phone) {
      router.replace("/register");
    }
  }, [router]);

  const flowPhone = getRegisterFlow().phone;

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
      if (codeJoined.length !== OTP_LEN) return;
      const phone = getRegisterFlow().phone;
      if (!phone) {
        router.replace("/register");
        return;
      }
      setError(null);
      startTransition(async () => {
        const result = await verifyRegisterOtp(phone, codeJoined);
        if (!result.ok) {
          if (result.reason === "expired") {
            setError("Code expired — request a new one.");
          } else if (result.reason === "server_error") {
            setError(
              "We could not save your registration session. Run the Supabase migration (register_completion_tokens) and ensure SUPABASE_SERVICE_ROLE_KEY is set on the server.",
            );
          } else {
            setError("Invalid code.");
          }
          return;
        }
        setRegisterFlow({
          verified: true,
          completionToken: result.completionToken,
        });
        setRegisterCompletionCookie(result.completionToken);
        router.push("/register/setup");
      });
    },
    [codeJoined, router],
  );

  return (
    <RegisterStepShell
      title="Enter code"
      subtext="We sent a 6-digit code to your number."
    >
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Badge variant="muted" className="uppercase tracking-[0.14em]">
          DEMO MODE
        </Badge>
        <span className="text-xs text-nq-muted">
          Mock SMS — check your dev server logs on the send-code step.
        </span>
      </div>

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
                "flex h-[52px] min-h-[52px] w-full items-center justify-center rounded-2xl border bg-nq-surface text-center font-mono text-xl tracking-[0.08em] text-nq-foreground outline-none transition-all duration-200",
                "border-nq-border focus:border-nq-primary focus:shadow-[0_0_0_3px_rgba(212,175,55,0.32)] focus:ring-2 focus:ring-nq-primary/40 focus:ring-offset-0",
                error &&
                  "border-nq-error focus:border-nq-error focus:shadow-none focus:ring-nq-error/35",
              )}
            />
          ))}
        </div>

        {flowPhone ? (
          <p className="text-center text-xs text-nq-muted">
            Number ending in ····{flowPhone.slice(-4)} — enter all 6 digits of the code.
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
          className="w-full"
          disabled={codeJoined.length !== OTP_LEN || pending}
        >
          {pending ? "Checking…" : "Continue"}
        </Button>

        <button
          type="button"
          className="text-center text-sm text-nq-primary-soft underline decoration-nq-primary/35 underline-offset-2 transition-opacity hover:opacity-90"
          onClick={() => router.push("/register")}
        >
          Use a different number
        </button>
      </form>
    </RegisterStepShell>
  );
}
