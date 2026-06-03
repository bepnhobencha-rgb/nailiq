"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { completeSalonOwnerPasswordReset } from "@/shared/auth/salonOwnerAuth";

type ErrorCode =
  | "weak_password"
  | "mismatch"
  | "no_session"
  | "no_salon_member"
  | "server_error";

const ERROR_COPY: Record<ErrorCode, string> = {
  weak_password: "Password must be at least 6 characters.",
  mismatch: "Passwords don't match.",
  no_session: "Reset link is no longer valid. Request a new one.",
  no_salon_member: "This account is not associated with a salon.",
  server_error: "Something went wrong. Try again.",
};

export function SalonOwnerResetPasswordForm() {
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
    if (password.length < 6) {
      setError("weak_password");
      return;
    }
    startTransition(async () => {
      const result = await completeSalonOwnerPasswordReset(password);
      if (result.ok) {
        // Recovery session is consumed; force a fresh sign-in.
        router.replace("/login?reset=ok");
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
      data-testid="salon-owner-reset-password-form"
    >
      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium text-nq-foreground">
          New password
        </span>
        <Input
          type="password"
          autoComplete="new-password"
          required
          minLength={6}
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
          Confirm password
        </span>
        <Input
          type="password"
          autoComplete="new-password"
          required
          minLength={6}
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
        Set new password
      </Button>

      {error ? (
        <p className="text-sm text-nq-error" role="alert">
          {ERROR_COPY[error]}
        </p>
      ) : null}
    </form>
  );
}
