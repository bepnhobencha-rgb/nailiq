"use client";

import Link from "next/link";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { getSuperadminAuthMessages } from "@/shared/i18n/superadmin/auth";
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
  const { language } = useUserLanguage();
  const t = getSuperadminAuthMessages(language);
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
          {t.forgotSentTitle}
        </p>
        <p className="text-sm text-nq-muted">
          {t.forgotSentBody}
        </p>
        <Link
          href="/superadmin/login"
          className="text-sm font-medium text-nq-accent underline-offset-4 hover:underline"
        >
          {t.backToSignIn}
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
        {t.forgotSubmit}
      </Button>

      {status === "error" ? (
        <p className="text-sm text-nq-error" role="alert">
          {t.serverError}
        </p>
      ) : null}

      <p className="text-sm text-nq-muted">
        {t.rememberedPassword}{" "}
        <Link
          href="/superadmin/login"
          className="font-medium text-nq-accent underline-offset-4 hover:underline"
        >
          {t.backToSignIn}
        </Link>
      </p>
    </form>
  );
}

export function SuperadminForgotPasswordIntro({ invalidOrExpired = false, temporarilyUnavailable = false }: { invalidOrExpired?: boolean; temporarilyUnavailable?: boolean }) {
  const { language } = useUserLanguage();
  const t = getSuperadminAuthMessages(language);
  return (
    <>
      <header className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-nq-muted">
          NailIQ
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
          {t.forgotTitle}
        </h1>
        <p className="text-sm text-nq-muted">
          {t.forgotSubtitle}
        </p>
      </header>

      {invalidOrExpired ? (
        <p className="text-sm text-nq-error" role="alert">
          {t.invalidLink}
        </p>
      ) : null}
      {temporarilyUnavailable ? (
        <p className="text-sm text-nq-error" role="alert">
          {t.recoveryUnavailable}
        </p>
      ) : null}
    </>
  );
}
