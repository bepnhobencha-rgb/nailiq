"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { requestSalonOwnerPasswordReset } from "@/shared/auth/salonOwnerAuth";

/**
 * Forgot-password form for salon owners.
 *
 * Always surfaces the same success copy on submit, regardless of
 * whether the email matched a salon owner account. The server action
 * enforces the anti-enumeration contract; the form just renders the outcome.
 * `server_error` is the only branch that surfaces a distinct message.
 */
export function ForgotPasswordClient() {
  const { language } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language).auth, [language]);
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sent" | "error">("idle");
  const [pending, startTransition] = useTransition();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (status === "error") setStatus("idle");
    startTransition(async () => {
      const result = await requestSalonOwnerPasswordReset(email);
      setStatus(result.ok ? "sent" : "error");
    });
  };

  if (status === "sent") {
    return (
      <div
        className="flex flex-col gap-3 rounded-md border border-nq-border bg-nq-surface px-4 py-4"
        data-testid="salon-owner-forgot-password-sent"
        role="status"
      >
        <p className="text-sm font-medium text-nq-foreground">
          {t.forgotPasswordSentTitle}
        </p>
        <p className="text-sm text-nq-muted">
          {t.forgotPasswordSentBody}
        </p>
        <Link
          href="/login"
          className="text-sm font-medium text-nq-accent underline-offset-4 hover:underline"
        >
          {t.forgotPasswordBackToSignIn}
        </Link>
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="flex w-full flex-col gap-4"
      data-testid="salon-owner-forgot-password-form"
    >
      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium text-nq-foreground">{t.emailLabel}</span>
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
        {pending ? t.forgotPasswordSubmitting : t.forgotPasswordSubmit}
      </Button>

      {status === "error" ? (
        <p className="text-sm text-nq-error" role="alert">
          {t.resetPasswordServerError}
        </p>
      ) : null}

      <p className="text-sm text-nq-muted">
        {`${t.emailLabel}? `}
        <Link
          href="/login"
          className="font-medium text-nq-accent underline-offset-4 hover:underline"
        >
          {t.forgotPasswordBackToSignIn}
        </Link>
      </p>
    </form>
  );
}
