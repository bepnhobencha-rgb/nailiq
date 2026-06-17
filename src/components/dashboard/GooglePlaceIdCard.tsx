"use client";

import { useState, useTransition } from "react";
import { updateGooglePlaceId } from "@/shared/dashboard/googleReviewActions";

/**
 * Settings card for the AI Review Responder.
 * Lets the owner enter their Google Place ID so the agent can poll reviews.
 *
 * How to find Place ID: search the salon on Google Maps → share → copy the link;
 * Place ID is in the URL as &ftid=0x..., or use Google's Place ID Finder tool.
 */
export function GooglePlaceIdCard({
  slug,
  initialPlaceId,
}: {
  slug: string;
  initialPlaceId: string | null;
}) {
  const [value, setValue] = useState(initialPlaceId ?? "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const isConfigured = Boolean(initialPlaceId);

  function handleSave() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const r = await updateGooglePlaceId(slug, value);
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
      data-testid="settings-google-place-id"
      className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-nq-foreground">AI Review Responder</p>
          <p className="mt-0.5 text-xs text-nq-muted">
            AI tự động soạn reply cho Google Review. 4–5★ gửi nháp qua email, 1–3★ cảnh báo để chủ tự xử lý.
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
          Google Place ID
          <span className="ml-1 opacity-60">(ChIJ…)</span>
        </label>
        <input
          type="text"
          inputMode="text"
          placeholder="ChIJN1t_tDeuEmsRUsoyG83frY4"
          value={value}
          disabled={isPending}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-xl border border-nq-border/40 bg-nq-surface/60 px-3 py-2.5 font-mono text-xs text-nq-foreground placeholder:text-nq-muted/50 focus:border-nq-primary/40 focus:outline-none focus:ring-1 focus:ring-nq-primary/30 disabled:opacity-50"
        />
        <p className="text-[10px] text-nq-muted/70">
          Tìm Place ID: Google Maps → tìm salon → chia sẻ → copy link, hoặc dùng{" "}
          <span className="underline underline-offset-2">developers.google.com/maps/documentation/places/web-service/place-id</span>
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
