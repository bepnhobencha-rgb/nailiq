"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { createClient } from "@/shared/lib/supabase/client";

type Mode = "login" | "register";

type Props = {
  mode: Mode;
};

const EMAIL_RE = /^\S+@\S+\.\S+$/;

export function SocialAuthButtons({ mode }: Props) {
  const [showEmail, setShowEmail] = useState(false);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onGoogle = () => {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const supabase = createClient();
      const { error: oauthErr } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (oauthErr) {
        setError(oauthErr.message ?? "Google sign-in failed.");
      }
    });
  };

  const onEmail = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setError("Enter a valid email address.");
      return;
    }
    startTransition(async () => {
      const supabase = createClient();
      const { error: otpErr } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (otpErr) {
        setError(otpErr.message ?? "Could not send link. Try again.");
        return;
      }
      setInfo("Magic link sent. Check your email to continue.");
    });
  };

  const emailButtonLabel =
    mode === "login" ? "Send login link" : "Send sign-up link";

  return (
    <div className="mt-6 flex flex-col gap-3">
      <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.18em] text-nq-muted">
        <span className="h-px flex-1 bg-nq-border" />
        <span>or</span>
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
        Continue with Google
      </Button>

      {showEmail ? (
        <form onSubmit={onEmail} className="flex flex-col gap-3">
          <Input
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
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
      ) : (
        <button
          type="button"
          onClick={() => {
            setError(null);
            setInfo(null);
            setShowEmail(true);
          }}
          className="self-center text-sm text-nq-muted underline-offset-4 transition hover:text-nq-foreground hover:underline"
        >
          Other options
        </button>
      )}

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
