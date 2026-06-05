"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyLookPreset } from "@/shared/dashboard/lookPresetActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import type { LookPreset } from "@/shared/verticals/lookPresets";

type Props = {
  slug: string;
  presets: LookPreset[];
  currentBrandColor: string;
  currentThemeMode: "light" | "dark";
};

const preview = (base: string) => `${base}?auto=format&fit=crop&q=60&w=320`;

/**
 * Owner picker: designed "looks" for the booking page. Clicking a card applies
 * the preset's imagery + colour + theme to the salon in one shot.
 */
export function LookPresetPicker({
  slug,
  presets,
  currentBrandColor,
  currentThemeMode,
}: Props) {
  const router = useRouter();
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Best-effort "active" highlight: a preset is active when its colour + theme
  // match the salon's current values.
  const activeId = presets.find(
    (p) =>
      p.brandColor.toLowerCase() === currentBrandColor.toLowerCase() &&
      p.themeMode === currentThemeMode,
  )?.id;

  function apply(p: LookPreset) {
    setError(null);
    setPendingId(p.id);
    startTransition(async () => {
      const res = await applyLookPreset(slug, p.id);
      setPendingId(null);
      if (res.ok) {
        router.refresh();
      } else {
        setError(vi ? "Không áp dụng được. Thử lại." : "Couldn't apply. Try again.");
      }
    });
  }

  return (
    <section
      data-testid="settings-look-presets"
      className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      <p className="text-sm font-semibold text-nq-foreground">
        {vi ? "Kiểu trang đặt lịch" : "Booking page style"}
      </p>
      <p className="mt-0.5 text-xs text-nq-muted">
        {vi
          ? "Chọn 1 kiểu thiết kế sẵn — ảnh, màu và nền sáng/tối đổi cùng lúc."
          : "Pick a designed look — imagery, colour and light/dark all change at once."}
      </p>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {presets.map((p) => {
          const isActive = p.id === activeId;
          const isPending = p.id === pendingId;
          return (
            <button
              key={p.id}
              type="button"
              disabled={isPending}
              onClick={() => apply(p)}
              className={`group overflow-hidden rounded-xl border text-left transition disabled:opacity-60 ${
                isActive
                  ? "border-nq-primary ring-1 ring-nq-primary/40"
                  : "border-nq-border/40 hover:border-nq-primary/40"
              }`}
            >
              <div className="relative h-20 w-full overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={preview(p.imagery.hero)}
                  alt={vi ? p.name.vi : p.name.en}
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
                <span
                  aria-hidden
                  className="absolute bottom-1.5 right-1.5 h-4 w-4 rounded-full border border-white/70 shadow"
                  style={{ background: p.brandColor }}
                />
              </div>
              <div className="flex items-center justify-between gap-1 px-2.5 py-1.5">
                <span className="truncate text-xs font-medium text-nq-foreground">
                  {vi ? p.name.vi : p.name.en}
                </span>
                {isActive ? (
                  <span className="shrink-0 text-[10px] font-semibold text-nq-primary">
                    {vi ? "Đang dùng" : "Active"}
                  </span>
                ) : isPending ? (
                  <span className="shrink-0 text-[10px] text-nq-muted">…</span>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>
      {error ? <p className="mt-2 text-xs text-nq-error">{error}</p> : null}
      <p className="mt-2 text-[11px] text-nq-muted">
        {vi
          ? "Muốn dùng ảnh riêng? Tải ảnh tiệm ở phần ảnh (giữ nguyên, không bị ghi đè khi không chọn kiểu)."
          : "Want your own photos? Upload them in the images section — they stay unless you pick a style."}
      </p>
    </section>
  );
}
