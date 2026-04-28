"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import { REG_COMPLETION_TOKEN_KEY } from "@/shared/lib/registerSessionKeys";
import { slugifySalonName } from "@/shared/lib/slugifySalonName";
import { completeSalonRegistration } from "@/shared/register/completeSalonRegistrationAction";

export default function RegisterSetupInner() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const token = window.sessionStorage.getItem(REG_COMPLETION_TOKEN_KEY);
    if (!token?.trim()) {
      router.replace("/register");
    }
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
      setFormError(null);
      startTransition(async () => {
        const completionToken =
          typeof window !== "undefined"
            ? window.sessionStorage.getItem(REG_COMPLETION_TOKEN_KEY)
            : null;

        const result = await completeSalonRegistration(trimmed, completionToken);

        if (!result.ok) {
          if (result.error === "unauthorized") {
            router.replace("/register");
            return;
          }
          if (result.error === "invalid_completion_token") {
            setFormError(
              "Your verification expired — start again from phone entry.",
            );
            return;
          }
          setFormError("Could not create your salon. Try again.");
          return;
        }

        if (typeof window !== "undefined") {
          window.sessionStorage.removeItem(REG_COMPLETION_TOKEN_KEY);
        }

        const adj = result.slugAdjusted ? "1" : "0";
        router.replace(
          `/register/success?slug=${encodeURIComponent(result.slug)}&adjusted=${adj}`,
        );
      });
    },
    [name, router],
  );

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
            className="text-base"
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
        <Button
          type="submit"
          size="lg"
          className="w-full min-h-11"
          disabled={!name.trim() || pending}
        >
          {pending ? "Creating…" : "Create your booking page"}
        </Button>
      </form>
    </RegisterStepShell>
  );
}
