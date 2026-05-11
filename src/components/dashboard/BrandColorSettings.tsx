"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/Button";
import { extractBrandFromUrl } from "@/shared/dashboard/extractBrandFromUrl";
import {
  updateBrandColor,
  updateSalonThemeMode,
} from "@/shared/dashboard/salonOwnerActions";
import {
  BRAND_COLOR_PRESETS,
  DEFAULT_BRAND_COLOR,
  isValidBrandColor,
  normalizeBrandColor,
} from "@/shared/lib/brandColor";
import { getUserMessages } from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type ExtractedBrand = { primary: string; themeMode: "dark" | "light" };

/**
 * Salon-member-only color picker for `salons.brand_color`. Renders a
 * native color input + a manual hex field + 6 preset swatches + a
 * live preview that mirrors how the booking page button / accent
 * text will land.
 *
 * Saves are explicit (not optimistic per-keystroke) — manual hex
 * entry would otherwise fire a write on every character. The preset
 * swatches save inline since the value is already valid.
 */

export function BrandColorSettings({
  slug,
  initialValue,
  initialThemeMode = "dark",
}: {
  slug: string;
  initialValue: string;
  /** `salons.theme_mode` — drives the booking page surface palette.
   *  Defaults to "dark" for legacy callers / pre-migration rows. */
  initialThemeMode?: "dark" | "light";
}) {
  const router = useRouter();
  const { language } = useUserLanguage();
  const t = getUserMessages(language).salonSettings.brandColor;

  const safeInitial = useMemo(
    () => normalizeBrandColor(initialValue),
    [initialValue],
  );
  const [color, setColor] = useState<string>(safeInitial);
  const [hexDraft, setHexDraft] = useState<string>(safeInitial);
  const [savedColor, setSavedColor] = useState<string>(safeInitial);
  const [themeMode, setThemeMode] = useState<"dark" | "light">(
    initialThemeMode,
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isThemePending, startThemeTransition] = useTransition();

  // "Match from website" extraction state. The URL is a controlled
  // input so we can clear it after a successful apply; result + error
  // are mutually exclusive (either we show the suggestion or the
  // error message).
  const [urlInput, setUrlInput] = useState<string>("");
  const [extractResult, setExtractResult] = useState<ExtractedBrand | null>(
    null,
  );
  const [extractError, setExtractError] = useState<string | null>(null);
  const [isExtractPending, startExtractTransition] = useTransition();
  const [isApplyPending, startApplyTransition] = useTransition();

  useEffect(() => {
    setColor(safeInitial);
    setHexDraft(safeInitial);
    setSavedColor(safeInitial);
    setError(null);
  }, [safeInitial]);

  useEffect(() => {
    setThemeMode(initialThemeMode);
  }, [initialThemeMode]);

  // Map `extractBrandFromUrl` discriminated-union error codes to
  // localized copy. Unknown codes fall back to the generic save error.
  const mapExtractError = (code: string): string => {
    switch (code) {
      case "invalid_url":
        return t.errorInvalidUrl;
      case "no_image":
        return t.errorNoImage;
      case "fetch_failed":
        return t.errorFetchFailed;
      case "image_too_large":
        return t.errorImageTooLarge;
      case "parse_failed":
        return t.errorParseFailed;
      default:
        return t.errorGeneric;
    }
  };

  const onAnalyzeUrl = () => {
    const trimmed = urlInput.trim();
    if (!trimmed) {
      setExtractError(t.errorInvalidUrl);
      setExtractResult(null);
      return;
    }
    setExtractError(null);
    setExtractResult(null);
    startExtractTransition(() => {
      void (async () => {
        const r = await extractBrandFromUrl(slug, trimmed);
        if (!r.ok) {
          setExtractError(mapExtractError(r.error));
          return;
        }
        setExtractResult({ primary: r.primary, themeMode: r.themeMode });
      })();
    });
  };

  const onApplyExtracted = () => {
    if (!extractResult) return;
    const target = extractResult;
    setExtractError(null);
    startApplyTransition(() => {
      void (async () => {
        const [colorRes, themeRes] = await Promise.all([
          updateBrandColor(slug, target.primary),
          updateSalonThemeMode(slug, target.themeMode),
        ]);
        if (!colorRes.ok || !themeRes.ok) {
          setExtractError(t.errorGeneric);
          return;
        }
        // Reflect the applied values in local state so the picker /
        // preview / theme toggle visibly snap to what just saved.
        setColor(target.primary);
        setHexDraft(target.primary);
        setSavedColor(target.primary);
        setThemeMode(target.themeMode);
        setExtractResult(null);
        setUrlInput("");
        router.refresh();
      })();
    });
  };

  const onDismissExtracted = () => {
    setExtractResult(null);
    setExtractError(null);
  };

  const persistThemeMode = (next: "dark" | "light") => {
    if (next === themeMode) return;
    const prev = themeMode;
    setThemeMode(next);
    setError(null);
    startThemeTransition(() => {
      void (async () => {
        const r = await updateSalonThemeMode(slug, next);
        if (!r.ok) {
          setThemeMode(prev);
          setError(t.errorGeneric);
          return;
        }
        router.refresh();
      })();
    });
  };

  const dirty = color.toUpperCase() !== savedColor.toUpperCase();
  const draftValid = isValidBrandColor(hexDraft);

  const persist = (next: string) => {
    if (!isValidBrandColor(next)) {
      setError(t.errorInvalid);
      return;
    }
    const upper = next.toUpperCase();
    const prevSaved = savedColor;
    setError(null);
    startTransition(() => {
      void (async () => {
        const r = await updateBrandColor(slug, upper);
        if (!r.ok) {
          setSavedColor(prevSaved);
          setError(r.error === "invalid_color" ? t.errorInvalid : t.errorGeneric);
          return;
        }
        setSavedColor(upper);
        router.refresh();
      })();
    });
  };

  const onPickColor = (next: string) => {
    setColor(next);
    setHexDraft(next.toUpperCase());
    setError(null);
  };

  const onChangeHex = (next: string) => {
    setHexDraft(next);
    if (isValidBrandColor(next)) {
      setColor(next.toUpperCase());
      setError(null);
    }
  };

  const onPickPreset = (hex: string) => {
    setColor(hex);
    setHexDraft(hex);
    setError(null);
    persist(hex);
  };

  const onSave = () => {
    if (!draftValid) {
      setError(t.errorInvalid);
      return;
    }
    persist(hexDraft);
  };

  const onResetDefault = () => {
    setColor(DEFAULT_BRAND_COLOR);
    setHexDraft(DEFAULT_BRAND_COLOR);
    setError(null);
    persist(DEFAULT_BRAND_COLOR);
  };

  return (
    <section
      data-testid="settings-brand-color"
      className="mt-4 rounded-2xl border border-nq-border/40 bg-nq-surface/45 px-4 py-4"
    >
      <header className="flex items-center gap-2">
        <span aria-hidden>🎨</span>
        <h2 className="text-base font-semibold text-nq-foreground">
          {t.sectionTitle}
        </h2>
      </header>
      <p className="mt-1 text-xs leading-relaxed text-nq-muted">
        {t.intro}
      </p>

      <div className="mt-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
          {t.themeLabel}
        </p>
        <div
          role="radiogroup"
          aria-label={t.themeLabel}
          className="mt-1.5 grid grid-cols-2 gap-2"
        >
          {(["dark", "light"] as const).map((mode) => {
            const active = themeMode === mode;
            const label = mode === "dark" ? t.themeDark : t.themeLight;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={isThemePending}
                onClick={() => persistThemeMode(mode)}
                data-testid={`brand-theme-${mode}`}
                className={cn(
                  "rounded-xl border px-3 py-2.5 text-left text-sm font-medium transition-colors",
                  active
                    ? "border-nq-primary/60 bg-nq-primary/10 text-nq-foreground"
                    : "border-nq-border/40 bg-nq-bg/30 text-nq-muted hover:border-nq-border hover:text-nq-foreground",
                  isThemePending && "pointer-events-none opacity-60",
                )}
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                      active
                        ? "border-nq-primary bg-nq-primary"
                        : "border-nq-muted/50 bg-transparent",
                    )}
                  >
                    {active ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-nq-bg" />
                    ) : null}
                  </span>
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div
        className="mt-4 rounded-xl border border-nq-border/40 bg-nq-bg/30 px-3 py-3"
        data-testid="brand-match-from-url"
      >
        <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
          {t.matchFromUrl}
        </p>

        {isExtractPending ? (
          <p
            className="mt-2 inline-flex items-center gap-2 text-sm text-nq-muted"
            role="status"
            aria-live="polite"
          >
            <span
              aria-hidden
              className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-nq-muted/30 border-t-nq-primary"
            />
            {t.analyzing}
          </p>
        ) : extractResult ? (
          <div className="mt-2 space-y-3" data-testid="brand-match-result">
            <p className="text-sm text-nq-foreground">{t.foundColors}</p>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="inline-flex items-center gap-2 font-mono uppercase tabular-nums text-nq-foreground">
                <span
                  aria-hidden
                  className="inline-block h-5 w-5 shrink-0 rounded-full border border-nq-muted/30"
                  style={{ backgroundColor: extractResult.primary }}
                />
                {extractResult.primary}
              </span>
              <span className="inline-flex items-center gap-1 text-nq-muted">
                <span aria-hidden>
                  {extractResult.themeMode === "light" ? "☀️" : "🌙"}
                </span>
                {extractResult.themeMode === "light"
                  ? t.themeLightSuggestion
                  : t.themeDarkSuggestion}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={isApplyPending}
                onClick={onApplyExtracted}
                data-testid="brand-match-apply"
              >
                {isApplyPending ? t.applying : t.applyColors}
              </Button>
              <button
                type="button"
                onClick={onDismissExtracted}
                disabled={isApplyPending}
                className="text-xs font-medium text-nq-muted hover:text-nq-foreground disabled:opacity-60"
                data-testid="brand-match-dismiss"
              >
                {t.dismissButton}
              </button>
            </div>
          </div>
        ) : extractError ? (
          <div className="mt-2 space-y-2" data-testid="brand-match-error">
            <p className="text-sm text-nq-error" role="alert">
              {extractError}
            </p>
            <button
              type="button"
              onClick={onDismissExtracted}
              className="text-xs font-medium text-nq-muted hover:text-nq-foreground"
            >
              {t.dismissButton}
            </button>
          </div>
        ) : (
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row sm:items-stretch">
            <input
              type="url"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              value={urlInput}
              placeholder={t.urlPlaceholder}
              disabled={isExtractPending}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onAnalyzeUrl();
                }
              }}
              data-testid="brand-match-url-input"
              className={cn(
                "h-10 w-full min-w-0 rounded-md border border-nq-muted/35 bg-nq-bg px-3 text-sm text-nq-foreground placeholder:text-nq-muted/60 focus:border-nq-primary focus:outline-none focus:ring-2 focus:ring-nq-primary/35",
                isExtractPending && "opacity-60",
              )}
            />
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={isExtractPending || urlInput.trim().length === 0}
              onClick={onAnalyzeUrl}
              data-testid="brand-match-analyze"
            >
              {t.analyzeButton}
            </Button>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <label className="inline-flex shrink-0 items-center">
          <span className="sr-only">{t.colorPickerAria}</span>
          <input
            type="color"
            value={color}
            disabled={isPending}
            onChange={(e) => onPickColor(e.target.value)}
            data-testid="brand-color-input"
            className="h-11 w-14 cursor-pointer rounded-md border border-nq-border bg-nq-bg p-1 disabled:opacity-60"
          />
        </label>
        <input
          type="text"
          value={hexDraft}
          maxLength={7}
          spellCheck={false}
          disabled={isPending}
          onChange={(e) => onChangeHex(e.target.value)}
          data-testid="brand-color-hex"
          className={cn(
            "h-11 w-32 rounded-md border bg-nq-bg px-3 font-mono text-sm uppercase tabular-nums text-nq-foreground focus:outline-none focus:ring-2 focus:ring-nq-primary/35",
            draftValid
              ? "border-nq-muted/35 focus:border-nq-primary"
              : "border-nq-error/55",
            isPending && "opacity-60",
          )}
        />
      </div>

      <div className="mt-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
          {t.presetsLabel}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {BRAND_COLOR_PRESETS.map((p) => {
            const active = p.hex.toUpperCase() === savedColor.toUpperCase();
            return (
              <button
                key={p.hex}
                type="button"
                disabled={isPending}
                onClick={() => onPickPreset(p.hex)}
                title={`${p.label} ${p.hex}`}
                aria-label={`${p.label} ${p.hex}`}
                data-testid={`brand-color-preset-${p.hex}`}
                className={cn(
                  "h-9 w-9 rounded-full border-2 transition-transform",
                  active
                    ? "border-nq-foreground scale-110"
                    : "border-nq-muted/30 hover:scale-105",
                  isPending && "pointer-events-none opacity-60",
                )}
                style={{ backgroundColor: p.hex }}
              />
            );
          })}
        </div>
      </div>

      <div
        data-testid="brand-color-preview"
        data-theme-mode={themeMode}
        className={cn(
          "mt-4 rounded-xl border p-3 transition-colors",
          themeMode === "light"
            ? "border-black/10 bg-[#f9f9f9]"
            : "border-nq-border/30 bg-[#0a0a0a]",
        )}
        style={
          {
            "--salon-primary": color,
          } as React.CSSProperties
        }
      >
        <p
          className={cn(
            "text-[11px] font-semibold uppercase tracking-wide",
            themeMode === "light" ? "text-black/45" : "text-nq-muted",
          )}
        >
          {t.previewLabel}
        </p>
        <div className="mt-2 flex items-center gap-3">
          <span
            className="inline-flex h-10 items-center rounded-lg px-4 text-sm font-semibold text-white"
            style={{ backgroundColor: "var(--salon-primary)" }}
          >
            {t.previewButton}
          </span>
          <span
            className="text-base font-bold"
            style={{ color: "var(--salon-primary)" }}
          >
            $45.00
          </span>
        </div>
      </div>

      {error ? (
        <p
          role="alert"
          data-testid="brand-color-error"
          className="mt-3 text-xs text-nq-error"
        >
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={onResetDefault}
          disabled={isPending}
          className="text-xs font-medium text-nq-muted hover:text-nq-foreground disabled:opacity-60"
        >
          {t.resetDefault}
        </button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={!dirty || !draftValid || isPending}
          onClick={onSave}
        >
          {isPending ? t.saving : t.save}
        </Button>
      </div>
    </section>
  );
}
