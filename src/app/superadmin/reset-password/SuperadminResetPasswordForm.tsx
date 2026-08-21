"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { completeSuperadminPasswordReset } from "@/shared/superadmin/superadminAuth";

type ErrorCode = "weak_password" | "mismatch" | "no_session" | "no_role" | "server_error";

const ERROR_COPY: Record<ErrorCode, string> = {
  weak_password: "Password must be 8–72 characters. / Mật khẩu phải có 8–72 ký tự.",
  mismatch: "Passwords don't match. / Mật khẩu không khớp.",
  no_session:
    "Reset link is no longer valid. Request a new one. / Link đặt lại không còn hiệu lực. Vui lòng yêu cầu link mới.",
  no_role:
    "This account is not an active SuperAdmin. / Tài khoản này không phải SuperAdmin đang hoạt động.",
  server_error: "Something went wrong. Try again. / Có lỗi xảy ra. Vui lòng thử lại.",
};

export function SuperadminResetPasswordForm() {
  const router = useRouter();
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
      const result = await completeSuperadminPasswordReset(password);
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
      >
        Set new password / Đặt mật khẩu mới
      </Button>

      {error ? (
        <p className="text-sm text-nq-error" role="alert">
          {ERROR_COPY[error]}
        </p>
      ) : null}
    </form>
  );
}
