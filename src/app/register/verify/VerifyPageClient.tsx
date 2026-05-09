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
import { Toast, type SetupToastPayload } from "@/components/ui/Toast";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import { cn } from "@/shared/lib/cn";
import {
  REG_COMPLETION_TOKEN_KEY,
  REG_FLOW_OWNER_RETURNING,
  REG_OTP_RESENT_FLAG,
  REG_SESSION_PHONE_DIGITS_KEY,
} from "@/shared/lib/registerSessionKeys";
import { dashboardPathForRole } from "@/shared/lib/salonMemberRole";
import { verifyRegisterOtp } from "@/shared/register/actions";
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
  const [toast, setToast] = useState<SetupToastPayload | null>(null);
  // Default checked: most salon owners register on a personal device and
  // expect to stay signed in. Phase 1 just threads the value through to
  // the server action; real session-lifetime gating lands in Phase 2.
  const [rememberDevice, setRememberDevice] = useState(true);
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const verifySubtext = useMemo(
    () =>
      isReturningFlow
        ? t.register.welcomeBackVerifySubtext
        : t.register.verifyDefaultSubtext,
    [
      isReturningFlow,
      t.register.welcomeBackVerifySubtext,
      t.register.verifyDefaultSubtext,
    ],
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

    // Resend flag set by RegisterPageClient on a successful re-send.
    // Surface the toast + clear any leftover digits (defensive — component
    // remount already empties `digits`, but covers HMR / fast-refresh and
    // any future caller that doesn't fully unmount).
    if (window.sessionStorage.getItem(REG_OTP_RESENT_FLAG) === "1") {
      window.sessionStorage.removeItem(REG_OTP_RESENT_FLAG);
      queueMicrotask(() => {
        setDigits(emptyDigits());
        setError(null);
        setToast({
          variant: "success",
          message: t.register.otpResentToast,
        });
      });
    }
  }, [router, t.register.otpResentToast]);

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
        const result = await verifyRegisterOtp(
          phoneDigits,
          codeJoined,
          rememberDevice,
        );

        if (!result.ok) {
          if (result.reason === "expired") {
            setError(t.register.verifyErrorExpired);
          } else if (result.reason === "server_error") {
            setError(t.register.verifyErrorServer);
          } else {
            setError(t.register.verifyErrorInvalid);
          }
          return;
        }

        if (typeof window !== "undefined") {
          window.sessionStorage.removeItem(REG_FLOW_OWNER_RETURNING);
        }

        if (result.next === "dashboard") {
          // Phase 1 multi-role login: senior / nail_tech land on /center,
          // owner stays on the dashboard root.
          window.location.assign(
            dashboardPathForRole(result.slug, result.role),
          );
          return;
        }

        if (result.next === "picker") {
          window.location.assign("/choose-salon");
          return;
        }

        const ct = result.completionToken.trim();
        if (!ct) {
          setError(t.register.verifyErrorMissingToken);
          return;
        }
        if (typeof window !== "undefined") {
          // Back-compat: still write to sessionStorage so an older
          // /register/setup tab in flight keeps working. New sessions
          // read the `?ct=…` URL param first (survives reload).
          window.sessionStorage.setItem(REG_COMPLETION_TOKEN_KEY, ct);
        }

        // Server-side flow state: thread the completion token through
        // the URL so /register/setup is recoverable on reload (the
        // payload row stores phone_digits server-side; see
        // 20260509230000_register_completion_tokens_payload.sql).
        window.location.assign(
          `/register/setup?ct=${encodeURIComponent(ct)}`,
        );
      });
    },
    [
      codeJoined,
      phoneDigits,
      rememberDevice,
      t.register.verifyErrorExpired,
      t.register.verifyErrorInvalid,
      t.register.verifyErrorMissingToken,
      t.register.verifyErrorServer,
    ],
  );

  return (
    <RegisterStepShell title={t.register.verifyTitle} subtext={verifySubtext}>
      {demoMode ? (
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <Badge variant="muted" className="uppercase tracking-[0.14em]">
            {isReturningFlow
              ? t.register.demoBadgeReturning
              : t.register.demoBadgeNew}
          </Badge>
          <span className="text-xs text-nq-muted">
            {isReturningFlow
              ? t.register.welcomeBackAfterSend
              : t.register.demoVerifyCaptionNew}
          </span>
        </div>
      ) : null}

      <form
        onSubmit={onSubmit}
        method="post"
        className="flex flex-col gap-6"
      >
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
            {t.register.verifyNumberEnding.replace(
              "{last4}",
              phoneDigits.slice(-4),
            )}
          </p>
        ) : null}

        {error ? (
          <p className="text-center text-sm text-nq-error" role="status">
            {error}
          </p>
        ) : null}

        <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-nq-border/40 bg-nq-surface/35 px-4 py-3 text-left transition-colors hover:bg-nq-surface/55">
          <input
            type="checkbox"
            checked={rememberDevice}
            onChange={(ev) => setRememberDevice(ev.target.checked)}
            className="mt-0.5 size-4 shrink-0 cursor-pointer accent-nq-primary"
          />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-nq-foreground">
              {t.register.verifyRememberLabel}
            </span>
            <span className="mt-0.5 block text-xs text-nq-muted">
              {t.register.verifyRememberSubLabel}
            </span>
          </span>
        </label>

        <Button
          type="submit"
          size="lg"
          className="w-full min-h-11"
          disabled={codeJoined.length !== OTP_LEN || pending || !phoneDigits}
        >
          {pending ? t.register.verifyChecking : t.register.verifyContinue}
        </Button>

        <button
          type="button"
          className="min-h-11 text-center text-sm text-nq-primary-soft underline decoration-nq-primary/35 underline-offset-2 transition-opacity duration-150 hover:opacity-90"
          onClick={() => router.push("/register")}
        >
          {t.register.verifyUseDifferentNumber}
        </button>
      </form>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </RegisterStepShell>
  );
}
