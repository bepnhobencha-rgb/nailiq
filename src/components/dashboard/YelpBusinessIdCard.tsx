"use client";

import { useState, useTransition } from "react";
import { updateYelpBusinessId } from "@/shared/dashboard/yelpReviewActions";

/**
 * Settings card for the AI Yelp Review Responder.
 * Owner enters their Yelp Business ID (the slug in the Yelp URL).
 * e.g. yelp.com/biz/hi-lite-head-spa-anaheim → ID is "hi-lite-head-spa-anaheim"
 */
export function YelpBusinessIdCard({
  slug,
  initialYelpId,
}: {
  slug: string;
  initialYelpId: string | null;
}) {
  const [value, setValue] = useState(initialYelpId ?? "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const isConfigured = Boolean(initialYelpId);

  function handleSave() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const r = await updateYelpBusinessId(slug, value);
      if (r.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      } else {
        setError(r.error ?? "Lưu thất bại");
      }
    });
  }

  return (
    <section
      data-testid="settings-yelp-business-id"
      className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-nq-foreground">AI Yelp Review Responder</p>
          <p className="mt-0.5 text-xs text-nq-muted">
            AI soạn reply cho Yelp review. 4–5★ gửi nháp qua email để copy-paste, 1–3★ cảnh báo để chủ tự xử lý.
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            isConfigured
              ? "bg-nq-success/15 text-nq-success"
              : "bg-nq-border/40 text-nq-muted"
          }`}
        >
          {isConfigured ? "✓ Đã kết nối" : "Chưa cài"}
        </span>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        <label className="text-[11px] font-medium text-nq-muted">
          Yelp Business ID
          <span className="ml-1 opacity-60">(slug trong URL Yelp)</span>
        </label>
        <input
          type="text"
          inputMode="text"
          placeholder="hi-lite-head-spa-anaheim"
          value={value}
          disabled={isPending}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-xl border border-nq-border/40 bg-nq-surface/60 px-3 py-2.5 font-mono text-xs text-nq-foreground placeholder:text-nq-muted/50 focus:border-nq-primary/40 focus:outline-none focus:ring-1 focus:ring-nq-primary/30 disabled:opacity-50"
        />
        <p className="text-[10px] text-nq-muted/70">
          Tìm Yelp Business ID: mở trang Yelp của salon → copy phần cuối URL sau{" "}
          <span className="font-mono">yelp.com/biz/</span>
        </p>
        {error ? <p className="text-xs text-nq-error">{error}</p> : null}
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={isPending}
            onClick={handleSave}
            className="rounded-xl border border-nq-primary/40 bg-nq-primary/10 px-3 py-1.5 text-xs font-semibold text-nq-primary transition hover:bg-nq-primary/15 disabled:opacity-50"
          >
            {isPending ? "Đang lưu…" : "Lưu"}
          </button>
          {saved ? <span className="text-xs text-nq-success">Đã lưu ✓</span> : null}
        </div>
      </div>
    </section>
  );
}
