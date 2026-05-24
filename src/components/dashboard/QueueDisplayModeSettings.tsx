"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { updateQueueDisplayMode } from "@/shared/dashboard/salonOwnerActions";
import { getUserMessages } from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

const optionClass = (active: boolean, disabled: boolean) =>
  cn(
    "flex flex-1 cursor-pointer select-none flex-col items-center gap-1 rounded-xl border px-3 py-2.5 text-center transition",
    active
      ? "border-nq-primary/60 bg-nq-primary/10 text-nq-foreground"
      : "border-nq-border/50 bg-nq-surface/30 text-nq-muted hover:border-nq-border",
    disabled && "cursor-not-allowed opacity-55",
  );

export function QueueDisplayModeSettings({
  slug,
  initialValue,
  canEdit,
}: {
  slug: string;
  initialValue: "simple" | "full";
  canEdit: boolean;
}) {
  const router = useRouter();
  const { language } = useUserLanguage();
  const t = getUserMessages(language).salonSettings.queueDisplayMode;

  const [mode, setMode] = useState<"simple" | "full">(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  /* eslint-disable react-hooks/set-state-in-effect -- intentional sync when parent prop changes */
  useEffect(() => {
    setMode(initialValue);
    setError(null);
  }, [initialValue]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const onSelect = (next: "simple" | "full") => {
    if (!canEdit || isPending || next === mode) return;
    const prev = mode;
    setMode(next);
    setError(null);
    startTransition(() => {
      void (async () => {
        const r = await updateQueueDisplayMode(slug, next);
        if (!r.ok) {
          setMode(prev);
          setError(t.errorGeneric);
          return;
        }
        router.refresh();
      })();
    });
  };

  return (
    <section
      data-testid="settings-queue-display-mode"
      className="mt-4 rounded-2xl border border-nq-border/40 bg-nq-surface/45 px-4 py-4"
    >
      <header className="flex items-center gap-2">
        <span aria-hidden>🗂️</span>
        <h2 className="text-base font-semibold text-nq-foreground">
          {t.sectionTitle}
        </h2>
      </header>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={!canEdit || isPending}
          onClick={() => onSelect("full")}
          data-testid="settings-queue-display-full"
          className={optionClass(mode === "full", !canEdit || isPending)}
        >
          <span className="text-sm font-semibold">{t.labelFull}</span>
          <span className="text-[11px] leading-snug text-nq-muted">
            {t.descriptionFull}
          </span>
        </button>
        <button
          type="button"
          disabled={!canEdit || isPending}
          onClick={() => onSelect("simple")}
          data-testid="settings-queue-display-simple"
          className={optionClass(mode === "simple", !canEdit || isPending)}
        >
          <span className="text-sm font-semibold">{t.labelSimple}</span>
          <span className="text-[11px] leading-snug text-nq-muted">
            {t.descriptionSimple}
          </span>
        </button>
      </div>

      {error ? (
        <p
          role="alert"
          data-testid="settings-queue-display-error"
          className="mt-2 text-xs text-nq-error"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}
