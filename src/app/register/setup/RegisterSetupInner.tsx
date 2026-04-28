"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import {
  clearRegisterFlow,
  getRegisterFlow,
  slugifySalonName,
} from "@/shared/lib/registerFlow";
import { completeSalonRegistration } from "@/shared/register/actions";

export default function RegisterSetupInner() {
  const router = useRouter();
  const snap = useMemo(() => getRegisterFlow(), []);

  useEffect(() => {
    if (!snap.phone) {
      router.replace("/register");
      return;
    }
    if (!snap.verified || !snap.completionToken) {
      router.replace("/register/verify");
      return;
    }
  }, [snap.phone, snap.verified, snap.completionToken, router]);

  const allowed = Boolean(snap.phone && snap.verified && snap.completionToken);

  const [name, setName] = useState(() =>
    allowed ? snap.salonName ?? "" : "",
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const previewSlug = useMemo(() => {
    const base = slugifySalonName(name.trim());
    return base || "my-salon";
  }, [name]);

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = name.trim();
      if (!trimmed) return;
      const token = getRegisterFlow().completionToken;
      if (!token) {
        router.replace("/register/verify");
        return;
      }
      setFormError(null);
      startTransition(async () => {
        const result = await completeSalonRegistration(token, trimmed);
        if (!result.ok) {
          if (result.error === "session_expired") {
            router.replace("/register/verify");
            return;
          }
          setFormError("Could not create your salon. Try again.");
          return;
        }
        clearRegisterFlow();
        const adj = result.slugAdjusted ? "1" : "0";
        router.replace(
          `/register/success?slug=${encodeURIComponent(result.slug)}&adjusted=${adj}`,
        );
      });
    },
    [name, router],
  );

  if (!allowed) {
    return (
      <RegisterStepShell title="What’s your salon name?">
        <div className="h-32 rounded-2xl bg-nq-surface/50" />
      </RegisterStepShell>
    );
  }

  return (
    <RegisterStepShell
      title="What’s your salon name?"
      subtext="This will appear on your public booking page."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-6">
        <div>
          <Input
            name="salonName"
            placeholder="e.g. A Nails"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (formError) setFormError(null);
            }}
            autoComplete="organization"
            autoFocus
            error={Boolean(formError)}
          />
          <p className="mt-3 text-pretty text-xs leading-relaxed text-nq-muted">
            Your booking URL uses a slug from this name (letters and numbers). If
            it’s already taken, we assign{" "}
            <span className="text-nq-foreground/90">…-2</span>,{" "}
            <span className="text-nq-foreground/90">…-3</span>, and so on.
          </p>
          <p className="mt-2 font-mono text-xs text-nq-primary-soft/95">
            /{previewSlug}
          </p>
          {formError ? (
            <p className="mt-2 text-sm text-nq-error" role="status">
              {formError}
            </p>
          ) : null}
        </div>
        <Button type="submit" size="lg" className="w-full" disabled={!name.trim() || pending}>
          {pending ? "Creating…" : "Create your booking page"}
        </Button>
      </form>
    </RegisterStepShell>
  );
}
