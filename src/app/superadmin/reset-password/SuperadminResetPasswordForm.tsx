"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { completeSuperadminPasswordReset } from "@/shared/superadmin/superadminAuth";

type ErrorCode = "weak_password" | "mismatch" | "no_session" | "no_role" | "server_error" | "unconfirmed";

const noopSubscribe = () => () => {};

const ERROR_COPY: Record<ErrorCode, string> = {
  weak_password: "Password must be 8–72 characters. / Mật khẩu phải có 8–72 ký tự.",
  mismatch: "Passwords don't match. / Mật khẩu không khớp.",
  no_session:
    "Reset link is no longer valid. Request a new one. / Link đặt lại không còn hiệu lực. Vui lòng yêu cầu link mới.",
  no_role:
    "This account is not an active SuperAdmin. / Tài khoản này không phải SuperAdmin đang hoạt động.",
  server_error: "Something went wrong. Try again. / Có lỗi xảy ra. Vui lòng thử lại.",
  unconfirmed:
    "We could not confirm whether your password changed. Try signing in with your new password. If it does not work, request a new reset link. / Chưa thể xác nhận mật khẩu đã được đổi. Hãy thử đăng nhập bằng mật khẩu mới. Nếu không đăng nhập được, hãy yêu cầu link đặt lại mới.",
};

export function SuperadminResetPasswordForm() {
  const router = useRouter();
  // A value typed into server HTML before onChange exists is lost on the
  // next controlled render. Accept input only after handlers are attached.
  const isHydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<ErrorCode | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("mismatch");
      return;
    }
    if (password.length < 8 || password.length > 72) {
      setError("weak_password");
      return;
    }
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof completeSuperadminPasswordReset>>;
      try {
        result = await completeSuperadminPasswordReset(password);
      } catch {
        // A lost response cannot tell us whether the password was committed.
        // Preserve the form without retrying or claiming success.
        setError("unconfirmed");
        return;
      }
      if (result.ok) {
        // Recovery session is consumed; force a fresh sign-in.
        router.replace("/superadmin/login?reset=ok");
        router.refresh();
        return;
      }
      setError(result.error);
    });
  };

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="flex w-full flex-col gap-4"
      data-testid="superadmin-reset-password-form"
    >
      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium text-nq-foreground">
          New password / Mật khẩu mới
        </span>
        <Input
          type="password"
          disabled={!isHydrated}
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={72}
          value={password}
          onChange={(ev) => {
            setPassword(ev.target.value);
            if (error) setError(null);
          }}
          aria-invalid={error !== null}
          error={error !== null}
          autoFocus
        />
      </label>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium text-nq-foreground">
          Confirm password / Xác nhận mật khẩu
        </span>
        <Input
          type="password"
          disabled={!isHydrated}
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={72}
          value={confirm}
          onChange={(ev) => {
            setConfirm(ev.target.value);
            if (error) setError(null);
          }}
          aria-invalid={error !== null}
          error={error !== null}
        />
      </label>

      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        loading={pending}
        disabled={!isHydrated || pending}
      >
        Set new password / Đặt mật khẩu mới
      </Button>

      {error ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-nq-error" role="alert">
            {ERROR_COPY[error]}
          </p>
          {error === "unconfirmed" ? (
            <Link
              href="/superadmin/login"
              className="inline-flex min-h-11 items-center text-sm text-nq-primary underline underline-offset-4"
            >
              Back to sign in / Quay lại đăng nhập
            </Link>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
