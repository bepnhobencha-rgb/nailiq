"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { requestSuperadminPasswordReset } from "@/shared/superadmin/superadminAuth";

/**
 * Forgot-password form for the SuperAdmin surface.
 *
 * Always surfaces the same success copy on submit, regardless of
 * whether the email matched an account. The server action enforces
 * the anti-enumeration contract; the form just renders the outcome.
 * `server_error` is the only branch that surfaces a distinct message.
 */
export function SuperadminForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sent" | "error">("idle");
  const [pending, startTransition] = useTransition();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (status === "error") setStatus("idle");
    startTransition(async () => {
      const result = await requestSuperadminPasswordReset(email);
      setStatus(result.ok ? "sent" : "error");
    });
  };

  if (status === "sent") {
    return (
      <div
        className="flex flex-col gap-3 rounded-md border border-nq-border bg-nq-surface px-4 py-4"
        data-testid="superadmin-forgot-password-sent"
        role="status"
      >
        <p className="text-sm font-medium text-nq-foreground">
          Check your inbox / Kiểm tra hộp thư
        </p>
        <p className="text-sm text-nq-muted">
          If the account is eligible, a password-reset link is on its way. /
          Nếu tài khoản đủ điều kiện, link đặt lại mật khẩu đang được gửi.
        </p>
        <Link
          href="/superadmin/login"
          className="text-sm font-medium text-nq-accent underline-offset-4 hover:underline"
        >
          Back to sign-in / Quay lại đăng nhập
        </Link>
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="flex w-full flex-col gap-4"
      data-testid="superadmin-forgot-password-form"
    >
      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium text-nq-foreground">Email</span>
        <Input
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          value={email}
          onChange={(ev) => {
            setEmail(ev.target.value);
            if (status === "error") setStatus("idle");
          }}
          aria-invalid={status === "error"}
          error={status === "error"}
          autoFocus
        />
      </label>

      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        loading={pending}
      >
        Send reset link / Gửi link đặt lại
      </Button>

      {status === "error" ? (
        <p className="text-sm text-nq-error" role="alert">
          Something went wrong. Try again. / Có lỗi xảy ra. Vui lòng thử lại.
        </p>
      ) : null}

      <p className="text-sm text-nq-muted">
        Remembered it? / Đã nhớ mật khẩu?{" "}
        <Link
          href="/superadmin/login"
          className="font-medium text-nq-accent underline-offset-4 hover:underline"
        >
          Back to sign-in / Quay lại đăng nhập
        </Link>
      </p>
    </form>
  );
}
