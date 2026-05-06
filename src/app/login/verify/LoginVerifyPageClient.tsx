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
import { verifyLoginOtp } from "@/shared/register/actions";

const OTP_LEN = 6;
const emptyDigits = () => Array.from({ length: OTP_LEN }, () => "");

type Props = { demoMode: boolean };

export function LoginVerifyPageClient({ demoMode }: Props) {
  const router = useRouter();
  const [digits, setDigits] = useState(emptyDigits);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [phoneDigits, setPhoneDigits] = useState<string | null>(null);
  const refs = useRef<(HTMLInputElement | null)[]>([]);

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
        const res = await verifyLoginOtp(phoneDigits, code);
        if (!res.ok) {
          setError(
            res.reason === "expired"
              ? "Mã đã hết hạn."
              : res.reason === "server_error"
                ? "Lỗi server. Vui lòng thử lại."
                : "Mã không đúng.",
          );
          return;
        }
        if (res.next === "dashboard") {
          // Phase 1 multi-role login: senior / nail_tech land on /center,
          // owner stays on the dashboard root.
          router.push(dashboardPathForRole(res.slug, res.role));
          return;
        }
        // next: "setup" means phone has no salon — login should reject this.
        // LoginPageClient pre-gates via sendLoginOtp; this is defense-in-depth.
        setError("Số này chưa đăng ký.");
      });
    },
    [phoneDigits, code, router],
  );

  return (
    <RegisterStepShell
      title="Nhập mã OTP"
      subtext={
        phoneDigits
          ? `Mã 6 số đã gửi đến số ${phoneDigits.slice(-4).padStart(phoneDigits.length, "•")}`
          : "Đang tải…"
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-6">
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
        <Button
          type="submit"
          size="lg"
          className="w-full min-h-11"
          disabled={pending || code.length !== OTP_LEN}
        >
          {pending ? "Đang xác thực…" : "Xác nhận"}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-nq-muted">
        <Link href="/login" className="text-nq-primary hover:underline">
          Đổi số điện thoại
        </Link>
      </p>
    </RegisterStepShell>
  );
}
