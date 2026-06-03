"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { completeSalonOwnerPasswordReset } from "@/shared/auth/salonOwnerAuth";

type ErrorCode =
  | "weak_password"
  | "mismatch"
  | "no_session"
  | "no_salon_member"
  | "server_error";

export function SalonOwnerResetPasswordForm() {
  const router = useRouter();
  const { language } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language).auth, [language]);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<ErrorCode | null>(null);
  const [pending, startTransition] = useTransition();

  const getPasswordStrength = (pwd: string): "weak" | "medium" | "strong" => {
    if (pwd.length < 8) return "weak";
    const hasUpper = /[A-Z]/.test(pwd);
    const hasNumber = /\d/.test(pwd);
    if (hasUpper && hasNumber) return "strong";
    if (hasUpper || hasNumber) return "medium";
    return "weak";
  };

  const passwordStrength = getPasswordStrength(password);
  const isPasswordAcceptable = passwordStrength === "medium" || passwordStrength === "strong";

  const ERROR_COPY: Record<ErrorCode, string> = {
    weak_password: t.passwordTooShort,
    mismatch: t.resetPasswordMismatch,
    no_session: t.resetPasswordInvalidLink,
    no_salon_member: "This account is not associated with a salon.",
    server_error: t.resetPasswordServerError,
  };

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
          {t.resetPasswordNewPassword}
        </span>
        <Input
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(ev) => {
            setPassword(ev.target.value);
            if (error) setError(null);
          }}
          aria-invalid={error !== null}
          error={error !== null}
          autoFocus
        />
        {password && (
          <div className="space-y-2">
            {/* Password strength meter */}
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 bg-nq-border rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all ${
                    passwordStrength === "strong"
                      ? "bg-green-500 w-full"
                      : passwordStrength === "medium"
                        ? "bg-yellow-500 w-2/3"
                        : "bg-red-500 w-1/3"
                  }`}
                />
              </div>
              <span
                className={`text-xs font-medium ${
                  passwordStrength === "strong"
                    ? "text-green-600"
                    : passwordStrength === "medium"
                      ? "text-yellow-600"
                      : "text-red-600"
                }`}
              >
                {t.resetPasswordStrengthHint}
                {passwordStrength === "strong"
                  ? t.passwordStrengthStrong
                  : passwordStrength === "medium"
                    ? t.passwordStrengthMedium
                    : t.passwordStrengthWeak}
              </span>
            </div>
            <p className="text-xs text-nq-muted">{t.passwordRequirements}</p>
          </div>
        )}
      </label>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium text-nq-foreground">
          {t.resetPasswordConfirmPassword}
        </span>
        <Input
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
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
        disabled={!isPasswordAcceptable || pending}
      >
        {pending ? t.resetPasswordSubmitting : t.resetPasswordSubmit}
      </Button>

      {error ? (
        <p className="text-sm text-nq-error" role="alert">
          {ERROR_COPY[error]}
        </p>
      ) : null}
    </form>
  );
}
