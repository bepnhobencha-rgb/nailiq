"use client";

import { Check, Palette, RotateCcw } from "lucide-react";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/Button";
import { saveReceptionistPreviewBgColor } from "@/shared/dashboard/drcThemeAction";
import {
  DEFAULT_RECEPTIONIST_PREVIEW_BG,
  RECEPTIONIST_PREVIEW_BG_PRESETS,
  sanitizeHex,
} from "@/shared/lib/drcTheme";

type ReceptionistPreviewThemePickerProps = {
  slug: string;
  currentBg: string;
  language: "en" | "vi";
  onBgChange: (hex: string) => void;
};

export function ReceptionistPreviewThemePicker({
  slug,
  currentBg,
  language,
  onBgChange,
}: ReceptionistPreviewThemePickerProps) {
  const [open, setOpen] = useState(false);
  const [customHex, setCustomHex] = useState(currentBg);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const copy =
    language === "vi"
      ? {
          open: "Đổi màu nền giao diện Mới",
          title: "Màu nền giao diện Mới",
          custom: "Màu tùy chọn",
          apply: "Áp dụng",
          reset: "Về mặc định",
          saving: "Đang lưu…",
          saved: "Đã lưu",
        }
      : {
          open: "Change New interface background",
          title: "New interface background",
          custom: "Custom color",
          apply: "Apply",
          reset: "Reset",
          saving: "Saving…",
          saved: "Saved",
        };

  function save(hex: string) {
    const clean = sanitizeHex(hex);
    if (!clean) return;

    onBgChange(clean);
    setCustomHex(clean);
    setSaved(false);
    const reset =
      clean.toLowerCase() === DEFAULT_RECEPTIONIST_PREVIEW_BG.toLowerCase();
    startTransition(async () => {
      const result = await saveReceptionistPreviewBgColor(
        slug,
        reset ? null : clean,
      );
      setSaved(result.ok);
    });
  }

  return (
    <div className="relative" data-testid="preview-theme-picker">
      <Button
        variant="secondary"
        size="sm"
        aria-expanded={open}
        aria-label={copy.open}
        title={copy.open}
        onClick={() => setOpen((value) => !value)}
        leftIcon={<Palette className="h-4 w-4" />}
      >
        <span className="hidden 2xl:inline">
          {language === "vi" ? "Màu nền" : "Background"}
        </span>
      </Button>

      {open ? (
        <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-2xl border border-[var(--rc-new-border)] bg-[var(--rc-new-surface)] p-4 text-[var(--rc-new-text)] shadow-xl">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm font-semibold">{copy.title}</p>
            {pending ? (
              <span className="text-xs text-[var(--rc-new-muted)]">
                {copy.saving}
              </span>
            ) : saved ? (
              <span className="inline-flex items-center gap-1 text-xs text-nq-success">
                <Check className="h-3.5 w-3.5" />
                {copy.saved}
              </span>
            ) : null}
          </div>

          <div className="grid grid-cols-6 gap-2">
            {RECEPTIONIST_PREVIEW_BG_PRESETS.map((preset) => {
              const active =
                preset.hex.toLowerCase() === currentBg.toLowerCase();
              return (
                <button
                  key={preset.hex}
                  type="button"
                  title={preset.label}
                  aria-label={preset.label}
                  aria-pressed={active}
                  onClick={() => save(preset.hex)}
                  className="relative h-9 min-h-9 rounded-lg border border-[var(--rc-new-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-info"
                  style={{ backgroundColor: preset.hex }}
                >
                  {active ? (
                    <Check className="absolute inset-0 m-auto h-4 w-4 text-[var(--rc-new-text)]" />
                  ) : null}
                </button>
              );
            })}
          </div>

          <label className="mt-4 block text-xs font-medium text-[var(--rc-new-muted)]">
            {copy.custom}
          </label>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="color"
              value={sanitizeHex(customHex) ?? DEFAULT_RECEPTIONIST_PREVIEW_BG}
              onChange={(event) => setCustomHex(event.target.value)}
              className="h-10 w-12 cursor-pointer rounded-lg border border-[var(--rc-new-border)] bg-transparent p-1"
              aria-label={copy.custom}
            />
            <input
              value={customHex}
              onChange={(event) => setCustomHex(event.target.value)}
              className="h-10 min-w-0 flex-1 rounded-lg border border-[var(--rc-new-border)] bg-[var(--rc-new-surface-subtle)] px-3 text-sm text-[var(--rc-new-text)] outline-none focus:border-nq-info"
              aria-label={`${copy.custom} hex`}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={!sanitizeHex(customHex) || pending}
              onClick={() => save(customHex)}
            >
              {copy.apply}
            </Button>
          </div>

          <button
            type="button"
            onClick={() => save(DEFAULT_RECEPTIONIST_PREVIEW_BG)}
            className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg text-xs font-medium text-[var(--rc-new-muted)] hover:bg-[var(--rc-new-surface-subtle)] hover:text-[var(--rc-new-text)]"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {copy.reset}
          </button>
        </div>
      ) : null}
    </div>
  );
}
