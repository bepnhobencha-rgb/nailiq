"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SetupToast, type SetupToastPayload } from "@/components/ui/Toast";
import {
  analyzeMenuImage,
  analyzeMenuImageUrl,
  bulkImportAIServices,
  type ExtractedService,
} from "@/shared/dashboard/aiPrefillServicesAction";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Step = "pick" | "loading" | "review";

type DraftService = ExtractedService & {
  selected: boolean;
  /** price in "$" string for editing */
  priceInput: string;
  durationInput: string;
};

function centsToDollars(cents: number | null): string {
  if (cents === null || cents === 0) return "";
  return (cents / 100).toFixed(2);
}

function dollarsInputToCents(raw: string): number {
  const n = parseFloat(raw.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

function toDraft(svc: ExtractedService): DraftService {
  return {
    ...svc,
    selected: true,
    priceInput: centsToDollars(svc.price_cents),
    durationInput: String(svc.duration_minutes),
  };
}

export function AIPrefillWizard({ slug }: { slug: string }) {
  const router = useRouter();
  const { language } = useUserLanguage();
  const t = getUserMessages(language).aiPrefill;

  const [step, setStep] = useState<Step>("pick");
  const [urlInput, setUrlInput] = useState("");
  const [drafts, setDrafts] = useState<DraftService[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState<SetupToastPayload | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Test observability only: server-rendered controls can be visible before
  // React attaches their event handlers. Expose an explicit readiness signal
  // so E2E does not type into an inert input and leave Analyze disabled.
  useEffect(() => {
    const hydrationWindow = window as typeof window & {
      __NAILIQ_AI_PREFILL_HYDRATED__?: string;
    };
    hydrationWindow.__NAILIQ_AI_PREFILL_HYDRATED__ = slug;
    return () => {
      if (hydrationWindow.__NAILIQ_AI_PREFILL_HYDRATED__ === slug) {
        delete hydrationWindow.__NAILIQ_AI_PREFILL_HYDRATED__;
      }
    };
  }, [slug]);

  const handleError = useCallback(
    (code: string) => {
      const map: Record<string, string> = {
        vision_failed: t.errorVisionFailed,
        invalid_response: t.errorVisionFailed,
        missing_api_key: t.errorVisionFailed,
        invalid_url: t.errorInvalidUrl,
        payload_too_large: t.errorPayloadTooLarge,
        plan_limit: t.errorPlanLimit,
        server_error: t.errorVisionFailed,
      };
      setErrorMsg(map[code] ?? t.errorVisionFailed);
      setStep("pick");
    },
    [t],
  );

  const afterAnalysis = useCallback((services: ExtractedService[]) => {
    if (services.length === 0) {
      setErrorMsg(services.length === 0 ? "" : "");
      // handled below
    }
    if (services.length === 0) {
      setErrorMsg(t.errorNoServices);
      setStep("pick");
      return;
    }
    setDrafts(services.map(toDraft));
    setStep("review");
  }, [t]);

  // ── File upload flow ──────────────────────────────────────────────────────

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setErrorMsg(null);
      setStep("loading");

      // Read as base64
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result as string;
        // dataUrl = "data:image/jpeg;base64,<data>"
        const [header, base64] = dataUrl.split(",");
        const mimeMatch = header?.match(/:(.*?);/);
        const mimeType = mimeMatch?.[1] ?? "image/jpeg";
        if (!base64) {
          handleError("vision_failed");
          return;
        }
        const res = await analyzeMenuImage(slug, base64, mimeType);
        if (!res.ok) { handleError(res.error); return; }
        afterAnalysis(res.services);
      };
      reader.onerror = () => handleError("vision_failed");
      reader.readAsDataURL(file);
    },
    [slug, handleError, afterAnalysis],
  );

  // ── URL flow ─────────────────────────────────────────────────────────────

  const handleUrlAnalyze = useCallback(async () => {
    if (!urlInput.trim()) return;
    setErrorMsg(null);
    setStep("loading");
    const res = await analyzeMenuImageUrl(slug, urlInput.trim());
    if (!res.ok) { handleError(res.error); return; }
    afterAnalysis(res.services);
  }, [slug, urlInput, handleError, afterAnalysis]);

  // ── Review helpers ────────────────────────────────────────────────────────

  const toggleAll = useCallback((select: boolean) => {
    setDrafts((prev) => prev.map((d) => ({ ...d, selected: select })));
  }, []);

  const toggleRow = useCallback((idx: number) => {
    setDrafts((prev) =>
      prev.map((d, i) => (i === idx ? { ...d, selected: !d.selected } : d)),
    );
  }, []);

  const updatePrice = useCallback((idx: number, val: string) => {
    setDrafts((prev) =>
      prev.map((d, i) => (i === idx ? { ...d, priceInput: val } : d)),
    );
  }, []);

  const updateDuration = useCallback((idx: number, val: string) => {
    setDrafts((prev) =>
      prev.map((d, i) => (i === idx ? { ...d, durationInput: val } : d)),
    );
  }, []);

  // ── Import ────────────────────────────────────────────────────────────────

  const handleImport = useCallback(async () => {
    const selected = drafts
      .filter((d) => d.selected)
      .map((d) => ({
        name: d.name,
        price_cents: dollarsInputToCents(d.priceInput),
        duration_minutes: Math.max(1, parseInt(d.durationInput, 10) || 1),
      }));
    if (selected.length === 0) return;

    setImporting(true);
    const res = await bulkImportAIServices(slug, selected);
    setImporting(false);

    if (!res.ok) {
      handleError(res.error);
      return;
    }

    setToast({ variant: "success", message: t.successToast });
    window.setTimeout(() => {
      router.push(`/dashboard/${slug}/setup/services`);
      router.refresh();
    }, 800);
  }, [drafts, slug, router, t, handleError]);

  const goManual = useCallback(() => {
    router.push(`/dashboard/${slug}/setup/services`);
  }, [router, slug]);

  const selectedCount = drafts.filter((d) => d.selected).length;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex w-full max-w-[var(--max-nq-mobile)] flex-col gap-6">
      <SetupToast toast={toast} onDismiss={() => setToast(null)} />

      {/* Error message */}
      {errorMsg && (
        <p
          role="alert"
          className="rounded-xl border border-nq-error/30 bg-nq-error/[0.06] px-4 py-3 text-sm text-nq-error"
        >
          {errorMsg}
        </p>
      )}

      {/* ── Step: pick ─────────────────────────────────────────────────── */}
      {step === "pick" && (
        <div className="flex flex-col gap-4">
          <div>
            <h1 className="text-xl font-semibold text-nq-foreground">{t.step1Title}</h1>
          </div>

          {/* Upload card */}
          <button
            type="button"
            data-testid="ai-prefill-upload-btn"
            onClick={() => fileInputRef.current?.click()}
            className="group flex w-full items-start gap-4 rounded-2xl border border-nq-border bg-nq-surface px-4 py-4 text-left transition-colors hover:border-nq-primary/60 hover:bg-nq-primary/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary"
          >
            <span
              aria-hidden
              className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-nq-primary/10 text-xl"
            >
              📷
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="font-semibold text-nq-foreground group-hover:text-nq-primary">
                {t.uploadCard}
              </span>
              <span className="text-sm text-nq-muted">{t.uploadCardSub}</span>
            </span>
          </button>
          {/* Hidden file input — accept camera on mobile */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={(e) => { void handleFileChange(e); }}
          />

          {/* URL card */}
          <div className="flex w-full flex-col gap-3 rounded-2xl border border-nq-border bg-nq-surface px-4 py-4">
            <div className="flex items-start gap-4">
              <span
                aria-hidden
                className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-nq-primary/10 text-xl"
              >
                🔗
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="font-semibold text-nq-foreground">{t.urlCard}</span>
                <span className="text-sm text-nq-muted">{t.urlCardSub}</span>
              </span>
            </div>
            <div className="flex gap-2">
              <input
                type="url"
                data-testid="ai-prefill-url-input"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder={t.urlPlaceholder}
                className="min-w-0 flex-1 rounded-xl border border-nq-border bg-nq-bg px-3 py-2 text-sm text-nq-foreground placeholder:text-nq-muted focus:border-nq-primary focus:outline-none focus:ring-2 focus:ring-nq-primary/30"
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter" && urlInput.trim()) {
                    void handleUrlAnalyze();
                  }
                }}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="ai-prefill-url-analyze"
                disabled={!urlInput.trim()}
                onClick={() => { void handleUrlAnalyze(); }}
              >
                {t.analyzeButton}
              </Button>
            </div>
          </div>

          {/* Manual card */}
          <button
            type="button"
            data-testid="ai-prefill-manual-btn"
            onClick={goManual}
            className="group flex w-full items-start gap-4 rounded-2xl border border-nq-border bg-nq-surface px-4 py-4 text-left transition-colors hover:border-nq-border/80 hover:bg-nq-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary"
          >
            <span
              aria-hidden
              className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-nq-surface text-xl"
            >
              ✏️
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="font-semibold text-nq-foreground">{t.manualCard}</span>
              <span className="text-sm text-nq-muted">{t.manualCardSub}</span>
            </span>
          </button>
        </div>
      )}

      {/* ── Step: loading ──────────────────────────────────────────────── */}
      {step === "loading" && (
        <div
          data-testid="ai-prefill-loading"
          className="flex min-h-[40dvh] flex-col items-center justify-center gap-5 text-center"
        >
          {/* Spinner — pure CSS, per ANIMATION_RULES */}
          <div
            className="h-10 w-10 animate-spin rounded-full border-4 border-nq-border border-t-nq-primary"
            role="status"
            aria-label={t.processingTitle}
          />
          <div>
            <p className="text-lg font-semibold text-nq-foreground">{t.processingTitle}</p>
            <p className="mt-1 text-sm text-nq-muted">{t.processingSub}</p>
          </div>
        </div>
      )}

      {/* ── Step: review ───────────────────────────────────────────────── */}
      {step === "review" && (
        <div data-testid="ai-prefill-review" className="flex flex-col gap-4">
          <div>
            <h1 className="text-xl font-semibold text-nq-foreground">{t.reviewTitle}</h1>
            <p className="mt-1 text-sm text-nq-muted">{t.reviewSub}</p>
          </div>

          {/* Select all / deselect all */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => toggleAll(true)}
              className="text-xs font-medium text-nq-primary underline-offset-2 hover:underline"
            >
              {t.selectAll}
            </button>
            <button
              type="button"
              onClick={() => toggleAll(false)}
              className="text-xs font-medium text-nq-muted underline-offset-2 hover:text-nq-foreground hover:underline"
            >
              {t.deselectAll}
            </button>
          </div>

          {/* Service rows */}
          <div className="flex flex-col divide-y divide-nq-border rounded-2xl border border-nq-border bg-nq-surface">
            {drafts.map((d, idx) => (
              <div
                key={idx}
                data-testid="ai-prefill-service-row"
                className={`flex items-start gap-3 px-4 py-3 transition-colors ${
                  d.selected ? "" : "opacity-50"
                }`}
              >
                <input
                  type="checkbox"
                  checked={d.selected}
                  onChange={() => toggleRow(idx)}
                  className="mt-1 h-4 w-4 shrink-0 accent-nq-primary"
                  aria-label={d.name}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-nq-foreground leading-snug">
                    {d.name}
                  </p>
                  <div className="mt-1.5 flex gap-3">
                    <label className="flex items-center gap-1 text-xs text-nq-muted">
                      <span>{t.priceLabel} $</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={d.priceInput}
                        onChange={(e) => updatePrice(idx, e.target.value)}
                        disabled={!d.selected}
                        className="w-16 rounded-md border border-nq-border bg-nq-bg px-2 py-0.5 text-xs text-nq-foreground focus:border-nq-primary focus:outline-none focus:ring-1 focus:ring-nq-primary/30 disabled:opacity-40"
                      />
                    </label>
                    <label className="flex items-center gap-1 text-xs text-nq-muted">
                      <span>{t.durationLabel}</span>
                      <input
                        type="number"
                        min="1"
                        step="5"
                        value={d.durationInput}
                        onChange={(e) => updateDuration(idx, e.target.value)}
                        disabled={!d.selected}
                        className="w-14 rounded-md border border-nq-border bg-nq-bg px-2 py-0.5 text-xs text-nq-foreground focus:border-nq-primary focus:outline-none focus:ring-1 focus:ring-nq-primary/30 disabled:opacity-40"
                      />
                    </label>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* CTA */}
          <div className="flex flex-col gap-2.5">
            <Button
              type="button"
              variant="primary"
              data-testid="ai-prefill-import-btn"
              className="w-full min-h-11"
              disabled={selectedCount === 0 || importing}
              loading={importing}
              onClick={() => { void handleImport(); }}
            >
              {selectedCount > 0
                ? t.importButtonN.replace("{n}", String(selectedCount))
                : t.importButton}
            </Button>
            <Button
              type="button"
              variant="ghost"
              data-testid="ai-prefill-manual-fallback"
              className="w-full min-h-11"
              disabled={importing}
              onClick={goManual}
            >
              {t.manualFallback}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
