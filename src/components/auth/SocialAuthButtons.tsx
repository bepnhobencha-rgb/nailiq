"use client";

import { useId, useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { createClient } from "@/shared/lib/supabase/client";

type Mode = "login" | "register";

type Props = {
  mode: Mode;
};

const EMAIL_RE = /^\S+@\S+\.\S+$/;

export function SocialAuthButtons({ mode }: Props) {
  // Source of truth = the EN/VI toggle in the marketing nav and the auth
  // shell. Previously this read `useBrowserLanguage`, which caused mixed
  // EN/VI strings on `/register` for VI-locale browsers.
  const { language } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language).auth, [language]);
  // Email magic-link section starts COLLAPSED. Only the Google button +
  // "Other options" toggle render until the user explicitly opens it.
  const [showEmail, setShowEmail] = useState(false);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const emailSectionId = useId();

  const onGoogle = () => {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const supabase = createClient();
      const { error: oauthErr } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: "https://www.nailiq.ca/auth/callback",
        },
      });
      if (oauthErr) {
        setError(oauthErr.message ?? t.googleSigninFailed);
      }
    });
  };

  const onEmail = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setError(t.emailInvalid);
      return;
    }
    startTransition(async () => {
      const supabase = createClient();
      const { error: otpErr } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: {
          emailRedirectTo: "https://www.nailiq.ca/auth/callback",
        },
      });
      if (otpErr) {
        setError(otpErr.message ?? t.magicLinkSendFailed);
        return;
      }
      setInfo(t.magicLinkSent);
    });
  };

  const emailButtonLabel =
    mode === "login" ? t.sendLoginLink : t.sendSignupLink;

  return (
    <div className="mt-6 flex flex-col gap-3">
      <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.18em] text-nq-muted">
        <span className="h-px flex-1 bg-nq-border" />
        <span>{t.orDivider}</span>
        <span className="h-px flex-1 bg-nq-border" />
      </div>

      <Button
        type="button"
        variant="secondary"
        size="lg"
        className="w-full min-h-11"
        loading={pending}
        onClick={onGoogle}
      >
        {t.continueWithGoogle}
      </Button>

      <button
        type="button"
        aria-expanded={showEmail}
        aria-controls={emailSectionId}
        data-testid="social-auth-other-options-toggle"
        onClick={() => {
          setError(null);
          setInfo(null);
          setShowEmail((prev) => !prev);
        }}
        className="self-center text-sm text-nq-muted underline-offset-4 transition hover:text-nq-foreground hover:underline"
      >
        {showEmail ? t.hideOptions : t.otherOptions}
      </button>

      {showEmail ? (
        <form
          id={emailSectionId}
          onSubmit={onEmail}
          method="post"
          className="flex flex-col gap-3"
        >
          <Input
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder={t.emailPlaceholder}
            value={email}
            onChange={(ev) => {
              setEmail(ev.target.value);
              if (error) setError(null);
            }}
            aria-invalid={Boolean(error)}
            error={Boolean(error)}
            autoFocus
          />
          <Button
            type="submit"
            variant="ghost"
            size="md"
            className="w-full"
            loading={pending}
          >
            {emailButtonLabel}
          </Button>
        </form>
      ) : null}

      {error ? (
        <p className="text-sm text-nq-error" role="status">
          {error}
        </p>
      ) : null}
      {info ? (
        <p className="text-sm text-nq-primary-soft" role="status">
          {info}
        </p>
      ) : null}
    </div>
  );
}
