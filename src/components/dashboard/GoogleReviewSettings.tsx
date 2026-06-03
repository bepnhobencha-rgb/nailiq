"use client";

import { useState, useTransition } from "react";
import { updateGoogleReviewUrl } from "@/shared/dashboard/googleReviewActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { getUserMessages } from "@/shared/i18n/user";

type Props = {
  slug: string;
  initialValue: string;
};

export function GoogleReviewSettings({ slug, initialValue }: Props) {
  const { language } = useUserLanguage();
  const t = getUserMessages(language);
  const [value, setValue] = useState(initialValue);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateGoogleReviewUrl(slug, value);
      if (result.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      } else {
        setError(result.error ?? t.salonSettings.googleReview.saveError);
      }
    });
  }

  return (
    <section
      data-testid="settings-google-review"
      className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      <p className="text-sm font-semibold text-nq-foreground">Google Review</p>
      <p className="mt-0.5 text-xs text-nq-muted">
        {t.salonSettings.googleReview.instruction}
      </p>
      <div className="mt-3 flex flex-col gap-2">
        <input
          type="url"
          inputMode="url"
          placeholder="https://g.page/r/..."
          value={value}
          disabled={isPending}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-xl border border-nq-border/40 bg-nq-surface/60 px-3 py-2.5 text-sm text-nq-foreground placeholder:text-nq-muted/60 focus:border-nq-primary/40 focus:outline-none focus:ring-1 focus:ring-nq-primary/30 disabled:opacity-50"
        />
        {error ? (
          <p className="text-xs text-nq-error">{error}</p>
        ) : null}
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={isPending}
            onClick={handleSave}
            className="rounded-xl border border-nq-primary/40 bg-nq-primary/10 px-3 py-1.5 text-xs font-semibold text-nq-primary transition hover:bg-nq-primary/15 disabled:opacity-50"
          >
            {isPending
              ? t.salonSettings.googleReview.saving
              : t.salonSettings.googleReview.save}
          </button>
          {saved ? (
            <span className="text-xs text-nq-success">
              {t.salonSettings.googleReview.saved}
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}
