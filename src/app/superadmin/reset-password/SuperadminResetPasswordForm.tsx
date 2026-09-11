"use client";

import Link from "next/link";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { getSuperadminAuthMessages } from "@/shared/i18n/superadmin/auth";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { completeSuperadminPasswordReset } from "@/shared/superadmin/superadminAuth";

type ErrorCode = "weak_password" | "mismatch" | "no_session" | "no_role" | "server_error" | "unconfirmed";

const noopSubscribe = () => () => {};

export function SuperadminResetPasswordForm() {
  const { language } = useUserLanguage();
  const t = getSuperadminAuthMessages(language);
  const errorCopy: Record<ErrorCode, string> = {
    weak_password: t.weakPassword,
    mismatch: t.mismatch,
    no_session: t.noSession,
    no_role: t.noRole,
    server_error: t.serverError,
    unconfirmed: t.unconfirmed,
  };
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
          {t.newPassword}
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
          {t.confirmPassword}
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
        {t.resetSubmit}
      </Button>

      {error ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-nq-error" role="alert">
            {errorCopy[error]}
          </p>
          {error === "unconfirmed" ? (
            <Link
              href="/superadmin/login"
              className="inline-flex min-h-11 items-center text-sm text-nq-primary underline underline-offset-4"
            >
              {t.backToSignIn}
            </Link>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

export function SuperadminResetPasswordHeader() {
  const { language } = useUserLanguage();
  const t = getSuperadminAuthMessages(language);
  return (
    <>
      <header className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-nq-muted">
          NailIQ
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
          {t.resetTitle}
        </h1>
        <p className="text-sm text-nq-muted">
          {t.resetSubtitle}
        </p>
      </header>
    </>
  );
}
