"use client";

import { useEffect, useState, useCallback } from "react";
import Image from "next/image";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";


type TrendItem = {
  photo_id: string;
  style: string;
  colors: string[];
  services: string[];
  booking_count: number;
  quality_score: number;
};

type TrendCacheRow = Database["public"]["Tables"]["ai_trend_cache"]["Row"];

type Props = {
  salonId: string;
  salonSlug: string;
  lang: "vi" | "en";
  onSelectStyle?: (serviceNames: string[]) => void;
};

const STYLE_LABELS: Record<string, { vi: string; en: string }> = {
  french_tip: { vi: "French Tip", en: "French Tip" },
  plain: { vi: "Đơn Sắc", en: "Solid Color" },
  ombre: { vi: "Ombre", en: "Ombre" },
  art: { vi: "Nail Art", en: "Nail Art" },
  glitter: { vi: "Kim Sa", en: "Glitter" },
  unknown: { vi: "Phong Cách", en: "Style" },
};

export function TrendingSection({ salonId, lang, onSelectStyle }: Props) {
  const [trends, setTrends] = useState<TrendItem[]>([]);
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<TrendItem | null>(null);
  const [loading, setLoading] = useState(true);

  const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  useEffect(() => {
    let mounted = true;
    supabase
      .from("ai_trend_cache")
      .select("trends, salon_id")
      .eq("salon_id", salonId)
      .eq("period", "this_week")
      .single()
      .then(({ data, error }) => {
        if (!mounted) return;
        setLoading(false);
        if (error) {
          console.warn("Failed to load trends:", error);
          return;
        }
        const typedData = data as any;
        if (typedData?.trends) {
          setTrends(typedData.trends as unknown as TrendItem[]);
        }
      });
    return () => { mounted = false; };
  }, [salonId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load signed URLs for photo thumbnails
  useEffect(() => {
    if (!trends.length) return;
    const ids = trends.map((t) => t.photo_id);
    fetch(`/api/photos/signed-urls?ids=${ids.join(",")}`)
      .then((r) => r.json())
      .then((data: Record<string, string>) => setPhotos(data))
      .catch(() => {});
  }, [trends]);

  const handleTileClick = useCallback(
    async (trend: TrendItem) => {
      setSelected(trend);
      // Track click-through
      await supabase
        .from("ai_trend_cache")
        .update({ click_through_count: supabase.rpc as unknown as number })
        .eq("salon_id", salonId)
        .eq("period", "this_week");
      // fire-and-forget increment via API instead
      fetch(`/api/trends/click`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ salon_id: salonId, photo_id: trend.photo_id }),
      }).catch(() => {});
    },
    [salonId, supabase]
  );

  if (loading || !trends.length) return null;

  const t = {
    title: lang === "vi" ? "Đang Thịnh Hành Tuần Này" : "Trending This Week",
    bookThisLook: lang === "vi" ? "Đặt Kiểu Này" : "Book This Look",
    close: lang === "vi" ? "Đóng" : "Close",
    times: lang === "vi" ? "lần" : "times",
  };

  return (
    <section className="mt-6 px-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-nq-muted">
        {t.title}
      </h2>

      <div className="flex gap-3 overflow-x-auto pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {trends.map((trend) => (
          <button
            key={trend.photo_id}
            onClick={() => handleTileClick(trend)}
            className="group relative shrink-0 cursor-pointer overflow-hidden rounded-xl border border-nq-border/40 bg-nq-surface transition-all duration-200 hover:border-nq-primary/60 hover:shadow-[var(--shadow-nq-tile-selected)]"
            style={{ width: 120, height: 150 }}
            aria-label={`${STYLE_LABELS[trend.style]?.[lang] ?? trend.style} — ${trend.booking_count} ${t.times}`}
          >
            {photos[trend.photo_id] ? (
              <Image
                src={photos[trend.photo_id]}
                alt={STYLE_LABELS[trend.style]?.[lang] ?? trend.style}
                fill
                className="object-cover transition-transform duration-300 group-hover:scale-105"
                sizes="120px"
              />
            ) : (
              <div className="h-full w-full animate-pulse bg-nq-surface/80" />
            )}
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-nq-bg/90 to-transparent px-2 py-2">
              <p className="text-xs font-medium text-nq-foreground">
                {STYLE_LABELS[trend.style]?.[lang] ?? trend.style}
              </p>
              <p className="text-[10px] text-nq-muted">
                {trend.booking_count} {t.times}
              </p>
            </div>
          </button>
        ))}
      </div>

      {/* Detail modal */}
      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-nq-bg/80 backdrop-blur-sm sm:items-center"
          onClick={() => setSelected(null)}
        >
          <div
            className="w-full max-w-sm rounded-t-2xl border border-nq-border/60 bg-nq-surface p-4 sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {photos[selected.photo_id] && (
              <div className="relative mb-4 h-64 w-full overflow-hidden rounded-xl">
                <Image
                  src={photos[selected.photo_id]}
                  alt={STYLE_LABELS[selected.style]?.[lang] ?? selected.style}
                  fill
                  className="object-cover"
                  sizes="400px"
                />
              </div>
            )}
            <p className="mb-1 text-lg font-semibold text-nq-foreground">
              {STYLE_LABELS[selected.style]?.[lang] ?? selected.style}
            </p>
            {selected.colors.length > 0 && (
              <p className="mb-3 text-sm text-nq-muted">
                {selected.colors.slice(0, 4).join(" · ")}
              </p>
            )}
            <div className="flex gap-2">
              <button
                className="flex-1 rounded-xl bg-nq-primary py-3 text-sm font-semibold text-nq-bg transition-opacity hover:opacity-90 active:opacity-80"
                onClick={() => {
                  onSelectStyle?.(selected.services);
                  setSelected(null);
                }}
              >
                {t.bookThisLook}
              </button>
              <button
                className="rounded-xl border border-nq-border/60 px-4 py-3 text-sm text-nq-muted transition-colors hover:text-nq-foreground"
                onClick={() => setSelected(null)}
              >
                {t.close}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
