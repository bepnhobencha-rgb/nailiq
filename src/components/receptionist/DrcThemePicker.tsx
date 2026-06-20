"use client";

import { useState, useTransition, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Palette, Check, RotateCcw } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import {
  FENG_SHUI_PRESETS,
  DEFAULT_DRC_ACCENT,
  sanitizeHex,
  contrastFg,
} from "@/shared/lib/drcTheme";
import { saveDrcAccentColor } from "@/shared/dashboard/drcThemeAction";

interface Props {
  slug: string;
  currentAccent: string;
  onAccentChange: (hex: string) => void;
}

export function DrcThemePicker({ slug, currentAccent, onAccentChange }: Props) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [customHex, setCustomHex] = useState(currentAccent);
  const [saved, setSaved] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});
  const [mounted, setMounted] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Ensure portal only renders client-side
  useEffect(() => { setMounted(true); }, []);

  // Recalculate position whenever picker opens — anchored to button via fixed coords
  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const popoverWidth = 240;
    const gap = 8;
    const left = Math.max(8, rect.right - popoverWidth);
    const top = rect.bottom + gap;
    setPopoverStyle({ top, left, width: popoverWidth });
  }, [open]);

  function pick(hex: string) {
    onAccentChange(hex);
    setCustomHex(hex);
    setSaved(false);
    const isDefault = hex.toLowerCase() === DEFAULT_DRC_ACCENT.toLowerCase();
    startTransition(async () => {
      const result = await saveDrcAccentColor(slug, isDefault ? null : hex);
      if (result.ok) setSaved(true);
    });
  }

  function applyCustom() {
    const valid = sanitizeHex(customHex);
    if (valid) pick(valid);
  }

  const picker = open && mounted ? createPortal(
    <>
      {/* Backdrop — rendered at body level, blocks ALL events from anything below */}
      <div
        className="fixed inset-0"
        style={{ zIndex: 9998 }}
        onClick={() => setOpen(false)}
        onMouseMove={(e) => e.stopPropagation()}
        onMouseOver={(e) => e.stopPropagation()}
        onPointerMove={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
      />

      {/* Popover — rendered at body level, above everything unconditionally */}
      <div
        className="fixed rounded-xl border border-[#2a2a2a] bg-[#111] p-4 shadow-2xl"
        style={{ ...popoverStyle, zIndex: 9999, maxHeight: "calc(100vh - 80px)", overflowY: "auto" }}
      >
        {/* Header */}
        <div className="mb-3 flex items-center justify-between">
          <p className="text-[11px] uppercase tracking-[2px] text-[#888]">
            Màu sắc DRC
          </p>
          {saved && (
            <span className="flex items-center gap-1 text-[11px] text-[#4caf50]">
              <Check size={10} />
              Đã lưu
            </span>
          )}
          {pending && (
            <span className="text-[11px] text-[#888]">Đang lưu…</span>
          )}
        </div>

        {/* Feng shui preset swatches — 4 per row */}
        <div className="mb-4 grid grid-cols-4 gap-2">
          {FENG_SHUI_PRESETS.map((p) => {
            const isActive = currentAccent.toLowerCase() === p.hex.toLowerCase();
            return (
              <button
                key={p.hex}
                type="button"
                onClick={() => pick(p.hex)}
                title={`${p.label} — ${p.desc}`}
                className={cn(
                  "relative h-10 w-full rounded-lg transition-all duration-150 hover:scale-105 hover:shadow-md",
                  isActive
                    ? "ring-2 ring-white ring-offset-1 ring-offset-[#111]"
                    : "ring-1 ring-white/10",
                )}
                style={{ backgroundColor: p.hex }}
              >
                {isActive && (
                  <span
                    className="absolute inset-0 flex items-center justify-center rounded-lg text-[12px] font-bold"
                    style={{ color: contrastFg(p.hex) }}
                  >
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Feng shui hint for active color */}
        {(() => {
          const active = FENG_SHUI_PRESETS.find(
            (p) => p.hex.toLowerCase() === currentAccent.toLowerCase(),
          );
          return active ? (
            <p className="mb-3 text-[11px] leading-relaxed text-[#666]">
              <span style={{ color: currentAccent }}>✦</span>{" "}
              {active.label} — {active.desc}
            </p>
          ) : null;
        })()}

        {/* Divider */}
        <div className="mb-3 border-t border-[#2a2a2a]" />

        {/* Custom color picker */}
        <p className="mb-2 text-[11px] text-[#666]">Màu tùy chỉnh</p>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={customHex.startsWith("#") ? customHex : "#c9a96e"}
            onChange={(e) => setCustomHex(e.target.value)}
            className="h-8 w-10 cursor-pointer rounded border-0 bg-transparent p-0"
            title="Chọn màu tùy chỉnh"
          />
          <div
            className="h-8 flex-1 rounded-lg border border-[#2a2a2a] px-2 text-[12px] flex items-center"
            style={{
              backgroundColor: sanitizeHex(customHex) ?? "#1a1a1a",
              color: sanitizeHex(customHex) ? contrastFg(customHex) : "#666",
            }}
          >
            {sanitizeHex(customHex) ?? "—"}
          </div>
          <button
            type="button"
            onClick={applyCustom}
            disabled={!sanitizeHex(customHex) || pending}
            className="rounded-lg bg-[#2a2a2a] px-3 py-1.5 text-[12px] text-white transition-colors hover:bg-[#3a3a3a] disabled:opacity-40"
          >
            Áp dụng
          </button>
        </div>

        {/* Reset to default */}
        <button
          type="button"
          onClick={() => pick(DEFAULT_DRC_ACCENT)}
          className="mt-3 flex w-full items-center justify-center gap-1.5 text-[11px] text-[#555] transition-colors hover:text-[#888]"
        >
          <RotateCcw size={10} />
          Về mặc định NailIQ
        </button>
      </div>
    </>,
    document.body,
  ) : null;

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Đổi màu DRC"
        aria-label="Đổi màu DRC"
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
          open ? "bg-white/15" : "hover:bg-white/10",
        )}
      >
        <Palette
          size={16}
          style={{ color: currentAccent }}
          className="transition-colors"
        />
      </button>

      {picker}
    </div>
  );
}
