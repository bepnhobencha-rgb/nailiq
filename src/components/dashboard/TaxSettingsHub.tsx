"use client";

import { useEffect, useState, useTransition } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import { loadTaxSettings, saveTaxSettings } from "@/shared/dashboard/taxSettingsActions";
import type { TaxLine } from "@/shared/tax/taxTypes";

function rateToPercent(rate: number): string {
  return (rate * 100).toFixed(rate === Math.round(rate * 100) / 100 ? 0 : 3).replace(/\.?0+$/, "");
}

function percentToRate(pct: string): number | null {
  const n = parseFloat(pct);
  if (isNaN(n) || n < 0 || n > 100) return null;
  return Math.round(n * 10000) / 1000000;
}

export function TaxSettingsHub({ slug }: { slug: string }) {
  const [lines, setLines] = useState<TaxLine[]>([]);
  const [preset, setPreset] = useState<TaxLine[] | null>(null);
  const [locationLabel, setLocationLabel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    void (async () => {
      const res = await loadTaxSettings(slug);
      if (res.ok) {
        setLines(res.taxLines);
        setPreset(res.preset);
        setLocationLabel(res.locationLabel);
      }
      setLoading(false);
    })();
  }, [slug]);

  function handleToggle(idx: number, val: boolean) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, enabled: val } : l)));
    setSaved(false);
  }

  function handleName(idx: number, val: string) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, name: val } : l)));
    setSaved(false);
  }

  function handleRate(idx: number, val: string) {
    const rate = percentToRate(val);
    if (rate === null) return;
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, rate } : l)));
    setSaved(false);
  }

  function handleDelete(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
    setSaved(false);
  }

  function handleAdd() {
    setLines((prev) => [...prev, { name: "", rate: 0, enabled: true }]);
    setSaved(false);
  }

  function handleResetToPreset() {
    if (preset) {
      setLines(preset);
      setSaved(false);
    }
  }

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const res = await saveTaxSettings(slug, lines);
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      } else {
        setError(
          res.error === "empty_name"
            ? "Tax line names cannot be empty."
            : res.error === "invalid_rate"
              ? "Rate must be between 0% and 100%."
              : "Failed to save. Please try again.",
        );
      }
    });
  }

  const effectiveTaxPct = lines
    .filter((l) => l.enabled)
    .reduce((s, l) => s + l.rate, 0);

  if (loading) {
    return (
      <Card variant="default" padding="md">
        <p className="text-sm text-nq-muted">Loading tax settings…</p>
      </Card>
    );
  }

  return (
    <Card variant="default" padding="md">
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-nq-foreground">Tax on services</h3>
          <p className="mt-0.5 text-xs text-nq-muted">
            {locationLabel ? `Detected region: ${locationLabel}. ` : ""}
            Add tax lines below — customers see a breakdown at checkout. Rates stored in
            your settings, not code, so changes take effect immediately.
          </p>
        </div>

        {lines.length === 0 ? (
          <p className="rounded-xl border border-nq-border/30 bg-nq-surface/40 px-4 py-3 text-sm text-nq-muted">
            No tax configured — customers see only the service price. Add a line below to
            start collecting tax.
          </p>
        ) : (
          <div className="space-y-2">
            {lines.map((line, idx) => (
              <div
                key={idx}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-nq-border/30 bg-nq-surface/40 px-3 py-2.5"
              >
                <Toggle
                  checked={line.enabled}
                  onChange={(v) => handleToggle(idx, v)}
                  aria-label={`Enable ${line.name || "tax line"}`}
                />
                <input
                  type="text"
                  value={line.name}
                  onChange={(e) => handleName(idx, e.target.value)}
                  placeholder="Tax name (e.g. GST)"
                  className="h-8 min-w-0 flex-1 rounded-lg border border-nq-border/40 bg-nq-bg px-2.5 text-sm text-nq-foreground placeholder:text-nq-muted focus:outline-none focus:ring-1 focus:ring-nq-primary/40"
                />
                <div className="flex h-8 items-center gap-0.5 rounded-lg border border-nq-border/40 bg-nq-bg px-2.5">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={0.001}
                    value={rateToPercent(line.rate)}
                    onChange={(e) => handleRate(idx, e.target.value)}
                    className="w-14 bg-transparent text-sm text-nq-foreground focus:outline-none"
                    aria-label="Rate %"
                  />
                  <span className="text-xs text-nq-muted">%</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(idx)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-nq-muted transition-colors hover:bg-nq-error/10 hover:text-nq-error"
                  aria-label="Remove tax line"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {lines.length > 0 && (
          <p className="text-xs text-nq-muted">
            Total tax on a booking:{" "}
            <strong className="text-nq-foreground">{(effectiveTaxPct * 100).toFixed(3).replace(/\.?0+$/, "")}%</strong>
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-nq-border/30 pt-3">
          <button
            type="button"
            onClick={handleAdd}
            className="rounded-lg border border-nq-border/40 px-3 py-1.5 text-xs font-medium text-nq-foreground transition-colors hover:border-nq-primary/40 hover:text-nq-primary"
          >
            + Add tax line
          </button>
          {preset && preset.length > 0 && (
            <button
              type="button"
              onClick={handleResetToPreset}
              className="rounded-lg border border-nq-border/40 px-3 py-1.5 text-xs font-medium text-nq-muted transition-colors hover:text-nq-foreground"
            >
              Reset to regional default
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {error && <p className="text-xs text-nq-error">{error}</p>}
            {saved && <p className="text-xs text-nq-success">Saved!</p>}
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={isPending}
            >
              {isPending ? "Saving…" : "Save tax settings"}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
