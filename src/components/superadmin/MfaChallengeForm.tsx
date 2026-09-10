"use client";

import { useId, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { verifyMfaChallenge } from "@/shared/superadmin/mfaActions";

const unavailable = "Could not confirm verification. Please try again.";

/** 6-digit TOTP entry for the login step-up (aal1 → aal2). */
export function MfaChallengeForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [pending, start] = useTransition();
  const inFlight = useRef(false);
  const inputId = useId();

  const submit = () => {
    if (inFlight.current || pending || !/^\d{6}$/.test(code)) return;
    inFlight.current = true;
    setError(null);
    setSessionExpired(false);
    start(async () => {
      try {
        const res = await verifyMfaChallenge(code);
        if (res.ok) {
          router.replace("/superadmin");
          router.refresh();
        } else {
          setSessionExpired(res.error === "unauthorized");
          setError(res.error === "unauthorized"
            ? "Session expired — sign in again."
            : res.error === "invalid_code" ? "Invalid code. Try again." : unavailable);
          if (res.error !== "verification_unavailable") setCode("");
        }
      } catch {
        setError(unavailable);
      } finally {
        inFlight.current = false;
      }
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-3"
    >
      <label htmlFor={inputId} className="sr-only">Authenticator code</label>
      <input
        id={inputId}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
        autoFocus
        disabled={pending}
        aria-describedby={error ? `${inputId}-error` : undefined}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        placeholder="000000"
        className="h-12 w-full rounded-xl border border-nq-border bg-nq-bg text-center text-2xl tracking-[0.4em] tabular-nums text-nq-foreground focus:outline-none focus:ring-2 focus:ring-nq-primary/40"
      />
      {error ? (
        <p id={`${inputId}-error`} role="alert" className="text-sm text-nq-error">
          {error}
        </p>
      ) : null}
      {sessionExpired ? (
        <Link href="/superadmin/login" className="inline-flex min-h-11 items-center text-sm text-nq-primary underline underline-offset-4">
          Sign in again
        </Link>
      ) : null}
      <Button
        type="submit"
        fullWidth
        disabled={pending || code.length !== 6}
        aria-busy={pending}
        className="h-11 rounded-xl font-semibold"
      >
        {pending ? "Verifying…" : "Verify"}
      </Button>
    </form>
  );
}
