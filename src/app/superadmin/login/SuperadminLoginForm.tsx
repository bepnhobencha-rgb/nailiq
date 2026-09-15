"use client";

import Link from "next/link";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { getSuperadminAuthMessages } from "@/shared/i18n/superadmin/auth";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { loginSuperadmin } from "@/shared/superadmin/superadminAuth";

/**
 * Email + password form for the superadmin sign-in route.
 *
 * Surfaces a single generic error ("Sign-in failed.") for both
 * `invalid_credentials` and `no_role` outcomes per
 * docs/PERMISSION_MATRIX.md §8 — an attacker must not be able to
 * probe whether an email belongs to a superadmin. `server_error` is
 * the only outcome that surfaces a distinct message so operators
 * know to retry rather than re-check their credentials.
 */
export function SuperadminLoginForm() {
  const { language } = useUserLanguage();
  const t = getSuperadminAuthMessages(language);
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<"serverError" | "signInFailed" | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await loginSuperadmin(email, password);
      if (result.ok) {
        router.replace("/superadmin");
        router.refresh();
        return;
      }
      setError(
        result.error === "server_error"
          ? "serverError"
          : "signInFailed",
      );
    });
  };

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="flex w-full flex-col gap-4"
      data-testid="superadmin-login-form"
    >
      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium text-nq-foreground">{t.email}</span>
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
            if (error) setError(null);
          }}
          aria-invalid={error !== null}
          error={error !== null}
          autoFocus
        />
      </label>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium text-nq-foreground">{t.password}</span>
        <Input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(ev) => {
            setPassword(ev.target.value);
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
        {t.signIn}
      </Button>

      {error ? (
        <p className="text-sm text-nq-error" role="alert">
          {t[error]}
        </p>
      ) : null}

      <p className="text-sm text-nq-muted">
        <Link
          href="/superadmin/forgot-password"
          className="font-medium text-nq-accent underline-offset-4 hover:underline"
          data-testid="superadmin-forgot-password-link"
        >
          {t.forgotPassword}
        </Link>
      </p>
    </form>
  );
}

export function SuperadminLoginIntro({ justReset = false, reauthenticationRequired = false }: { justReset?: boolean; reauthenticationRequired?: boolean }) {
  const { language } = useUserLanguage();
  const t = getSuperadminAuthMessages(language);
  return (
    <>
      <header className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-nq-muted">
          NailIQ
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
          {t.loginTitle}
        </h1>
        <p className="text-sm text-nq-muted">
          {t.loginSubtitle}
        </p>
      </header>

      {justReset ? (
        <div
          className="flex items-start gap-3 rounded-md border border-nq-success/40 bg-nq-success/15 px-4 py-3 text-nq-success"
          role="status"
          data-testid="superadmin-password-reset-banner"
        >
          <svg
            className="mt-0.5 size-5 shrink-0"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.236 4.53L7.53 9.97a.75.75 0 0 0-1.06 1.06l2.5 2.5a.75.75 0 0 0 1.137-.089l3.75-5.25Z"
              clipRule="evenodd"
            />
          </svg>
          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-semibold">
              {t.passwordUpdatedTitle}
            </p>
            <p className="text-sm opacity-90">
              {t.passwordUpdatedBody}
            </p>
          </div>
        </div>
      ) : null}

      {reauthenticationRequired ? (
        <div
          className="rounded-md border border-nq-warning/40 bg-nq-warning/10 px-4 py-3 text-sm text-nq-foreground"
          role="status"
          data-testid="superadmin-reauthentication-notice"
        >
          {t.reauthenticationRequired}
        </div>
      ) : null}
    </>
  );
}
