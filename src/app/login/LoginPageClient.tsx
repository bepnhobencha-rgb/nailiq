"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { DemoOtpModal } from "@/components/register/DemoOtpModal";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import {
  REG_FLOW_OWNER_RETURNING,
  REG_SESSION_PHONE_DIGITS_KEY,
} from "@/shared/lib/registerSessionKeys";
import { sendLoginOtp } from "@/shared/register/actions";
import {
  isRegisterPhoneDigitsValid,
  normalizeRegisterPhone,
} from "@/shared/register/phone";

type Props = { demoMode: boolean };

export function LoginPageClient({ demoMode }: Props) {
  const router = useRouter();
  const [phoneRaw, setPhoneRaw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [demoCode, setDemoCode] = useState<string | null>(null);

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const normalized = normalizeRegisterPhone(phoneRaw);
      if (!isRegisterPhoneDigitsValid(normalized)) {
        setError("Nhập 8–15 chữ số có mã quốc gia (vd: 84912345678).");
        return;
      }
      setError(null);
      startTransition(async () => {
        // sendLoginOtp pre-checks salon ownership; rejects unknown phones
        // BEFORE sending SMS (saves cost in prod, faster feedback in dev).
        const result = await sendLoginOtp(normalized);

        if (!result.success) {
          setError(result.error);
          return;
        }

        if (typeof window !== "undefined") {
          window.sessionStorage.setItem(
            REG_SESSION_PHONE_DIGITS_KEY,
            normalized,
          );
          window.sessionStorage.setItem(REG_FLOW_OWNER_RETURNING, "1");
        }

        if (result.code) {
          setDemoCode(result.code);
          return;
        }
        router.push("/login/verify");
      });
    },
    [phoneRaw, router],
  );

  return (
    <RegisterStepShell
      title="Đăng nhập"
      subtext={
        demoMode
          ? "Demo mode hiển thị mã OTP trên màn hình."
          : "Bạn sẽ nhận mã OTP qua SMS."
      }
    >
      <DemoOtpModal
        code={demoCode ?? ""}
        open={Boolean(demoCode)}
        onDismiss={() => setDemoCode(null)}
        onContinue={() => {
          setDemoCode(null);
          router.push("/login/verify");
        }}
      />

      <p className="mb-2 text-sm text-nq-muted sm:mb-4">
        Nhập số điện thoại đã đăng ký salon.
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
          {pending ? "Đang gửi…" : "Gửi mã"}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-nq-muted">
        Chưa có salon?{" "}
        <Link href="/register" className="font-medium text-nq-primary hover:underline">
          Đăng ký
        </Link>
      </p>
    </RegisterStepShell>
  );
}
