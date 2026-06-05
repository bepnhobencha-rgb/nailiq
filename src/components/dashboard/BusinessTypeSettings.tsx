"use client";

import { useState, useTransition } from "react";
import { updateSalonVertical } from "@/shared/dashboard/salonOwnerActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { VERTICAL_OPTIONS } from "@/shared/verticals/registry";

type Props = {
  slug: string;
  initialVertical: string;
};

/**
 * Owner-only Admin control to set the salon's business vertical. Changing it
 * re-labels the public booking page (schema.org type, staff-role label, hero
 * tagline fallback) and the AI assistants — no code change or redeploy needed.
 */
export function BusinessTypeSettings({ slug, initialVertical }: Props) {
  const { language } = useUserLanguage();
  const isVi = language === "vi";
  const [vertical, setVertical] = useState(initialVertical || "nail_salon");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleChange(next: string) {
    setVertical(next);
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateSalonVertical(slug, next);
      if (result.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      } else {
        setError(
          isVi
            ? "Không lưu được loại hình. Thử lại."
            : "Couldn't save the business type. Try again.",
        );
      }
    });
  }

  return (
    <section
      data-testid="settings-business-type"
      className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      <p className="text-sm font-semibold text-nq-foreground">
        {isVi ? "Loại hình kinh doanh" : "Business type"}
      </p>
      <p className="mt-0.5 text-xs text-nq-muted">
        {isVi
          ? "Quyết định nhãn nghề nhân viên, lời chào AI và dữ liệu SEO trên trang đặt lịch công khai."
          : "Sets the staff-role label, AI assistant wording, and SEO data on your public booking page."}
      </p>
      <div className="mt-3 flex flex-col gap-2">
        <select
          value={vertical}
          disabled={isPending}
          onChange={(e) => handleChange(e.target.value)}
          className="w-full rounded-xl border border-nq-border/40 bg-nq-surface/60 px-3 py-2.5 text-sm text-nq-foreground focus:border-nq-primary/40 focus:outline-none focus:ring-1 focus:ring-nq-primary/30 disabled:opacity-50"
        >
          {VERTICAL_OPTIONS.map((opt) => (
            <option key={opt.slug} value={opt.slug}>
              {isVi ? opt.label.vi : opt.label.en}
            </option>
          ))}
        </select>
        {error ? <p className="text-xs text-nq-error">{error}</p> : null}
        {saved ? (
          <span className="text-xs text-nq-success">
            {isVi ? "Đã lưu" : "Saved"}
          </span>
        ) : null}
      </div>
    </section>
  );
}
