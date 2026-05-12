"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/Button";
import { updateDashboardModules } from "@/shared/dashboard/salonOwnerActions";
import {
  DASHBOARD_MODULE_OWNER_TOGGLES,
  type DashboardModulesConfig,
} from "@/shared/dashboard/dashboardModules";
import { getUserMessages } from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type OwnerRow = {
  key: (typeof DASHBOARD_MODULE_OWNER_TOGGLES)[number];
  label: keyof ReturnType<
    typeof getUserMessages
  >["salonSettings"]["dashboardModules"]["labels"];
};

// P1.13 — the 4 toggles owners actually flip day-to-day stay visible
// up top. The remaining 6 fold into a collapsed "Advanced" section so
// the panel reads as 4 decisions, not 10.
const PRIMARY_ROWS: OwnerRow[] = [
  { key: "sound_alerts", label: "soundAlerts" },
  { key: "ai_suggestions", label: "aiSuggestions" },
  { key: "revenue_today", label: "revenueToday" },
  { key: "kpi_bar", label: "kpiBar" },
];

const ADVANCED_ROWS: OwnerRow[] = [
  { key: "quick_add", label: "quickAdd" },
  { key: "wait_time", label: "waitTime" },
  { key: "alerts", label: "alerts" },
  { key: "vip_indicators", label: "vipIndicators" },
  { key: "staff_performance", label: "staffPerformance" },
  { key: "timeline_heatmap", label: "timelineHeatmap" },
];

const toggleInputClass =
  "h-6 w-6 shrink-0 cursor-pointer rounded-md border border-nq-border bg-nq-bg accent-nq-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg disabled:cursor-not-allowed disabled:opacity-45";

export function DashboardModulesSettings({
  slug,
  initialModules,
  canEdit,
}: {
  slug: string;
  initialModules: DashboardModulesConfig;
  canEdit: boolean;
}) {
  const router = useRouter();
  const { language } = useUserLanguage();
  const t = getUserMessages(language).salonSettings.dashboardModules;

  const [modules, setModules] = useState<DashboardModulesConfig>(initialModules);
  const [baseline, setBaseline] =
    useState<DashboardModulesConfig>(initialModules);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // P1.13 — advanced section is collapsed by default. Opens with a
  // user-visible chevron rotate so it's discoverable but doesn't
  // bloat the initial scan of the panel.
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    setModules(initialModules);
    setBaseline(initialModules);
    setError(null);
  }, [initialModules]);

  const dirty = useMemo(
    () =>
      DASHBOARD_MODULE_OWNER_TOGGLES.some((k) => modules[k] !== baseline[k]),
    [modules, baseline],
  );

  const reset = () => {
    setModules(baseline);
    setError(null);
  };

  const save = () => {
    setError(null);
    const payload: Partial<DashboardModulesConfig> = {};
    for (const k of DASHBOARD_MODULE_OWNER_TOGGLES) {
      payload[k] = modules[k];
    }
    startTransition(() => {
      void (async () => {
        const r = await updateDashboardModules(slug, payload);
        if (r.ok) {
          setModules(r.modules);
          setBaseline(r.modules);
          router.refresh();
        } else if (r.error === "forbidden") {
          setError(t.forbidden);
        } else if (r.error === "invalid_keys") {
          setError(t.invalidKeys);
        } else {
          setError(t.saveError);
        }
      })();
    });
  };

  return (
    <section
      className="mt-8 rounded-2xl border border-nq-border/40 bg-nq-surface/35 p-4 ring-1 ring-inset ring-nq-primary/10"
      aria-labelledby="dashboard-modules-heading"
    >
      <h2
        id="dashboard-modules-heading"
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

      <ul className="mt-4 flex flex-col gap-0 divide-y divide-nq-border/25 border-y border-nq-border/25">
        <li className="flex items-center justify-between gap-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-nq-foreground">
              {t.coreTimeline}
            </p>
            <p className="text-xs text-nq-muted">{t.lockedHint}</p>
          </div>
          <input
            type="checkbox"
            checked
            readOnly
            disabled
            tabIndex={-1}
            aria-label={t.coreTimeline}
            className={toggleInputClass}
          />
        </li>
        <li className="flex items-center justify-between gap-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-nq-foreground">{t.coreStaff}</p>
            <p className="text-xs text-nq-muted">{t.lockedHint}</p>
          </div>
          <input
            type="checkbox"
            checked
            readOnly
            disabled
            tabIndex={-1}
            aria-label={t.coreStaff}
            className={toggleInputClass}
          />
        </li>
        <li className="flex items-center justify-between gap-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-nq-foreground">{t.coreQueue}</p>
            <p className="text-xs text-nq-muted">{t.lockedHint}</p>
          </div>
          <input
            type="checkbox"
            checked
            readOnly
            disabled
            tabIndex={-1}
            aria-label={t.coreQueue}
            className={toggleInputClass}
          />
        </li>

        {PRIMARY_ROWS.map(({ key, label }) => (
          <li
            key={key}
            className="flex items-center justify-between gap-4 py-3"
          >
            <label
              htmlFor={`dm-${key}`}
              className={cn(
                "min-w-0 cursor-pointer select-none text-sm font-medium text-nq-foreground",
                !canEdit && "cursor-default opacity-70",
              )}
            >
              {t.labels[label]}
            </label>
            <input
              id={`dm-${key}`}
              type="checkbox"
              role="switch"
              checked={modules[key]}
              disabled={!canEdit || isPending}
              aria-checked={modules[key]}
              onChange={(e) =>
                setModules((prev) => ({ ...prev, [key]: e.target.checked }))
              }
              className={toggleInputClass}
            />
          </li>
        ))}
      </ul>

      <div className="mt-4">
        <button
          type="button"
          data-testid="dashboard-modules-advanced-toggle"
          aria-expanded={advancedOpen}
          aria-controls="dashboard-modules-advanced-list"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 rounded-lg border border-nq-border/40 bg-nq-bg/60 px-3 py-2 text-sm font-medium text-nq-foreground hover:bg-nq-bg/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/40"
        >
          <span>{t.advancedSectionTitle}</span>
          <span
            aria-hidden
            className={cn(
              "transition-transform duration-200",
              advancedOpen && "rotate-180",
            )}
          >
            ▼
          </span>
        </button>
        {advancedOpen ? (
          <ul
            id="dashboard-modules-advanced-list"
            className="mt-2 flex flex-col gap-0 divide-y divide-nq-border/25 border-y border-nq-border/25"
          >
            {ADVANCED_ROWS.map(({ key, label }) => (
              <li
                key={key}
                className="flex items-center justify-between gap-4 py-3"
              >
                <label
                  htmlFor={`dm-${key}`}
                  className={cn(
                    "min-w-0 cursor-pointer select-none text-sm font-medium text-nq-foreground",
                    !canEdit && "cursor-default opacity-70",
                  )}
                >
                  {t.labels[label]}
                </label>
                <input
                  id={`dm-${key}`}
                  type="checkbox"
                  role="switch"
                  checked={modules[key]}
                  disabled={!canEdit || isPending}
                  aria-checked={modules[key]}
                  onChange={(e) =>
                    setModules((prev) => ({
                      ...prev,
                      [key]: e.target.checked,
                    }))
                  }
                  className={toggleInputClass}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="ghost"
          disabled={!canEdit || !dirty || isPending}
          onClick={reset}
        >
          {t.reset}
        </Button>
        <Button
          type="button"
          variant="primary"
          loading={isPending}
          disabled={!canEdit || !dirty || isPending}
          onClick={save}
        >
          {t.save}
        </Button>
      </div>
    </section>
  );
}
