"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { verifyMfaChallenge } from "@/shared/superadmin/mfaActions";
import { cn } from "@/shared/lib/cn";

/** 6-digit TOTP entry for the login step-up (aal1 → aal2). */
export function MfaChallengeForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = () => {
    setError(null);
    start(async () => {
      const res = await verifyMfaChallenge(code);
      if (res.ok) {
        router.replace("/superadmin");
        router.refresh();
      } else {
        setError(
          res.error === "unauthorized"
            ? "Session expired — sign in again."
            : "Invalid code. Try again.",
        );
        setCode("");
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
      <input
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        placeholder="000000"
        className="h-12 w-full rounded-xl border border-nq-border bg-nq-bg text-center text-2xl tracking-[0.4em] tabular-nums text-nq-foreground focus:outline-none focus:ring-2 focus:ring-nq-primary/40"
      />
      {error ? (
        <p role="alert" className="text-sm text-nq-error">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending || code.length !== 6}
        className={cn(
          "h-11 w-full rounded-xl bg-nq-primary text-sm font-semibold text-nq-bg transition-opacity",
          (pending || code.length !== 6) && "opacity-50",
        )}
      >
        {pending ? "Verifying…" : "Verify"}
      </button>
    </form>
  );
}
