"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { updateDashboardPreset } from "@/shared/dashboard/salonOwnerActions";
import {
  PRESET_KEYS,
  type PresetKey,
} from "@/shared/dashboard/dashboardPresets";
import { getUserMessages } from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

export function DashboardPresetSettings({
  slug,
  initialPreset,
  canEdit,
}: {
  slug: string;
  initialPreset: PresetKey;
  canEdit: boolean;
}) {
  const router = useRouter();
  const { language } = useUserLanguage();
  const t = getUserMessages(language).salonSettings.dashboardPreset;

  const [preset, setPreset] = useState<PresetKey>(initialPreset);
  const [pendingPreset, setPendingPreset] = useState<PresetKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  /* eslint-disable react-hooks/set-state-in-effect -- intentional sync when parent prop changes (server re-fetch) */
  useEffect(() => {
    setPreset(initialPreset);
    setError(null);
    setPendingPreset(null);
  }, [initialPreset]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const choose = (next: PresetKey) => {
    if (!canEdit || isPending || next === preset) return;
    setError(null);
    setPendingPreset(next);
    startTransition(() => {
      void (async () => {
        const r = await updateDashboardPreset(slug, next);
        if (r.ok) {
          setPreset(r.preset);
          setPendingPreset(null);
          router.refresh();
        } else {
          setPendingPreset(null);
          if (r.error === "forbidden") setError(t.forbidden);
          else if (r.error === "invalid_preset") setError(t.invalid);
          else if (r.error === "unauthorized") setError(t.forbidden);
          else setError(t.saveError);
        }
      })();
    });
  };

  return (
    <section
      className="mt-8 rounded-2xl border border-nq-border/40 bg-nq-surface/35 p-4 ring-1 ring-inset ring-nq-primary/10"
      aria-labelledby="dashboard-preset-heading"
    >
      <h2
        id="dashboard-preset-heading"
        className="text-base font-semibold text-nq-foreground"
      >
        {t.sectionTitle}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-nq-muted">
        {t.sectionIntro}
      </p>

      {!canEdit ? (
        <p className="mt-3 text-sm text-nq-muted">{t.ownerOnlyHint}</p>
      ) : null}

      {error ? (
        <p className="mt-3 text-sm font-medium text-nq-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {PRESET_KEYS.map((key) => {
          const isActive = key === preset;
          const isLoadingThis = pendingPreset === key;
          const cardState = isActive
            ? "selected"
            : canEdit
              ? "interactive"
              : "static";
          return (
            <Card
              key={key}
              as="button"
              type="button"
              onClick={canEdit ? () => choose(key) : undefined}
              variant="bordered"
              padding="md"
              state={cardState}
              disabled={!canEdit || isPending}
              aria-pressed={isActive}
              aria-label={t.labels[key]}
              className={cn(
                "w-full text-left",
                !canEdit && "cursor-not-allowed opacity-70",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-nq-foreground">
                    {t.labels[key]}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-nq-muted">
                    {t.descriptions[key]}
                  </p>
                </div>
                {isActive ? (
                  <Badge variant="vip" size="sm" state="default">
                    {t.activeBadge}
                  </Badge>
                ) : null}
              </div>
              {isLoadingThis ? (
                <p className="mt-2 text-xs text-nq-muted">{t.applying}</p>
              ) : null}
            </Card>
          );
        })}
      </div>
    </section>
  );
}

export default DashboardPresetSettings;
