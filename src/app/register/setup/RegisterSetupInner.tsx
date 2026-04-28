"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import {
  clearRegisterFlow,
  clearRegisterCompletionCookie,
  getRegisterCompletionTokenClient,
  getRegisterFlow,
  setRegisterFlow,
  slugifySalonName,
} from "@/shared/lib/registerFlow";
import {
  completeSalonRegistration,
  validateRegisterCompletionToken,
} from "@/shared/register/actions";

export default function RegisterSetupInner() {
  const router = useRouter();
  const [bootstrap, setBootstrap] = useState<"checking" | "ready" | "unauthorized">(
    "checking",
  );
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    async function init() {
      const flowPhone = getRegisterFlow().phone;
      if (!flowPhone) {
        if (!cancelled) {
          setBootstrap("unauthorized");
          router.replace("/register");
        }
        return;
      }

      const token = getRegisterCompletionTokenClient();
      if (!token) {
        if (!cancelled) {
          setBootstrap("unauthorized");
          router.replace("/register");
        }
        return;
      }

      const fromStorage = getRegisterFlow().completionToken;
      if (!fromStorage && token) {
        setRegisterFlow({
          verified: true,
          completionToken: token,
        });
      }

      const { valid } = await validateRegisterCompletionToken(token);
      if (cancelled) return;
      if (!valid) {
        clearRegisterFlow();
        setBootstrap("unauthorized");
        router.replace("/register");
        return;
      }

      const flow = getRegisterFlow();
      setName(flow.salonName ?? "");
      setBootstrap("ready");
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const previewSlug = useMemo(() => {
    const base = slugifySalonName(name.trim());
    return base || "my-salon";
  }, [name]);

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = name.trim();
      if (!trimmed) return;
      const token = getRegisterCompletionTokenClient();
      if (!token) {
        clearRegisterFlow();
        router.replace("/register");
        return;
      }
      setFormError(null);
      startTransition(async () => {
        const result = await completeSalonRegistration(token, trimmed);
        if (!result.ok) {
          if (result.error === "session_expired" || result.error === "missing_token") {
            clearRegisterFlow();
            router.replace("/register");
            return;
          }
          setFormError("Could not create your salon. Try again.");
          return;
        }
        // Keep phone + verified in localStorage so /dashboard/[slug] can recognize the owner.
        // Only drop the one-time completion token + cookie (server already consumed the token).
        clearRegisterCompletionCookie();
        setRegisterFlow({
          verified: true,
          completionToken: "",
          salonName: trimmed,
          slug: result.slug,
        });
        const adj = result.slugAdjusted ? "1" : "0";
        router.replace(
          `/register/success?slug=${encodeURIComponent(result.slug)}&adjusted=${adj}`,
        );
      });
    },
    [name, router],
  );

  if (bootstrap === "checking") {
    return (
      <RegisterStepShell title="What’s your salon name?">
        <div className="h-32 rounded-2xl bg-nq-surface/50" />
      </RegisterStepShell>
    );
  }

  if (bootstrap === "unauthorized") {
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
