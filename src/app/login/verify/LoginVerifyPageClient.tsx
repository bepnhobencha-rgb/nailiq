"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { Button } from "@/components/ui/Button";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import { cn } from "@/shared/lib/cn";
import { REG_SESSION_PHONE_DIGITS_KEY } from "@/shared/lib/registerSessionKeys";
import { dashboardPathForRole } from "@/shared/lib/salonMemberRole";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { getUserMessages } from "@/shared/i18n/user";
import { verifyLoginOtp } from "@/shared/register/actions";

const OTP_LEN = 6;
const emptyDigits = () => Array.from({ length: OTP_LEN }, () => "");

type Props = { demoMode: boolean };

export function LoginVerifyPageClient({ demoMode: _demoMode }: Props) {
  // demoMode currently unused on /login/verify; kept on the prop list so
  // server pages don't need a separate signature for the two verify routes.
  void _demoMode;
  const router = useRouter();
  const { language } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language).login, [language]);
  const [digits, setDigits] = useState(emptyDigits);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [phoneDigits, setPhoneDigits] = useState<string | null>(null);
  // Default checked: most salon owners log in from a personal device and
  // expect to stay signed in. Phase 1 just threads the value through to
  // the server action; real session-lifetime gating lands in Phase 2.
  const [rememberDevice, setRememberDevice] = useState(true);
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const registerT = useMemo(
    () => getUserMessages(language).register,
    [language],
  );

  // Restore phone from session (set by /login form). If missing, send the
  // user back to the phone-entry step.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.sessionStorage.getItem(REG_SESSION_PHONE_DIGITS_KEY);
    if (!stored) {
      router.replace("/login");
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot session-storage hydration
    setPhoneDigits(stored);
  }, [router]);

  const code = useMemo(() => digits.join(""), [digits]);

  const onChangeDigit = useCallback((idx: number, value: string) => {
    const v = value.replace(/\D/g, "").slice(0, 1);
    setDigits((prev) => {
      const next = [...prev];
      next[idx] = v;
      return next;
    });
    if (v && idx < OTP_LEN - 1) refs.current[idx + 1]?.focus();
  }, []);

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!phoneDigits || code.length !== OTP_LEN) return;
      setError(null);

      startTransition(async () => {
        const res = await verifyLoginOtp(phoneDigits, code, rememberDevice);
        if (!res.ok) {
          setError(
            res.reason === "expired"
              ? t.verifyErrorExpired
              : res.reason === "server_error"
                ? t.verifyErrorServer
                : t.verifyErrorInvalid,
          );
          return;
        }
        if (res.next === "dashboard") {
          // Phase 1 multi-role login: senior / nail_tech land on /center,
          // owner stays on the dashboard root.
          router.push(dashboardPathForRole(res.slug, res.role));
          return;
        }
        if (res.next === "picker") {
          router.push("/choose-salon");
          return;
        }
        // next: "setup" means phone has no salon — login should reject this.
        // LoginPageClient pre-gates via sendLoginOtp; this is defense-in-depth.
        setError(t.verifyErrorNoSalon);
      });
    },
    [
      phoneDigits,
      code,
      rememberDevice,
      router,
      t.verifyErrorExpired,
      t.verifyErrorInvalid,
      t.verifyErrorNoSalon,
      t.verifyErrorServer,
    ],
  );

  const subtext = phoneDigits
    ? t.verifySubtextSent.replace(
        "{masked}",
        phoneDigits.slice(-4).padStart(phoneDigits.length, "•"),
      )
    : t.verifySubtextLoading;

  return (
    <RegisterStepShell title={t.verifyTitle} subtext={subtext}>
      <form
        onSubmit={onSubmit}
        method="post"
        className="flex flex-col gap-6"
      >
        <div className="flex justify-center gap-2">
          {digits.map((d, i) => (
            <input
              key={i}
              ref={(el) => {
                refs.current[i] = el;
              }}
              inputMode="numeric"
              maxLength={1}
              className={cn(
                "h-12 w-10 rounded-lg border bg-nq-bg text-center text-xl text-nq-foreground",
                error ? "border-nq-error" : "border-nq-muted/35",
              )}
              value={d}
              onChange={(ev) => onChangeDigit(i, ev.target.value)}
              autoFocus={i === 0}
            />
          ))}
        </div>
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
              {registerT.verifyRememberLabel}
            </span>
            <span className="mt-0.5 block text-xs text-nq-muted">
              {registerT.verifyRememberSubLabel}
            </span>
          </span>
        </label>

        <Button
          type="submit"
          size="lg"
          className="w-full min-h-11"
          disabled={pending || code.length !== OTP_LEN}
        >
          {pending ? t.verifyVerifying : t.verifyConfirm}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-nq-muted">
        <Link href="/login" className="text-nq-primary hover:underline">
          {t.verifyChangePhone}
        </Link>
      </p>
    </RegisterStepShell>
  );
}
