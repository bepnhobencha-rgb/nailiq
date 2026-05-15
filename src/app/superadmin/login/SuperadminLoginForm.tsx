"use client";

import Link from "next/link";
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
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
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
          ? "Something went wrong. Try again."
          : "Sign-in failed.",
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
            if (error) setError(null);
          }}
          aria-invalid={error !== null}
          error={error !== null}
          autoFocus
        />
      </label>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium text-nq-foreground">Password</span>
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
        Sign in
      </Button>

      {error ? (
        <p className="text-sm text-nq-error" role="alert">
          {error}
        </p>
      ) : null}

      <p className="text-sm text-nq-muted">
        <Link
          href="/superadmin/forgot-password"
          className="font-medium text-nq-accent underline-offset-4 hover:underline"
          data-testid="superadmin-forgot-password-link"
        >
          Forgot password?
        </Link>
      </p>
    </form>
  );
}
