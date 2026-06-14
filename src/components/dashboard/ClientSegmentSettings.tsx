"use client";

import { useState, useTransition } from "react";
import { updateClientSegmentSettings } from "@/shared/dashboard/salonOwnerActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Props = {
  slug: string;
  initialNewMaxVisits: number;
  initialAtRiskDays: number;
};

const VISIT_PRESETS = [1, 2, 3, 5] as const;
const DAY_PRESETS = [30, 60, 90, 120] as const;

/**
 * Owner setting: how the Clients page buckets customers.
 *   - "New"      → visits ≤ newMaxVisits
 *   - "At-risk"  → a returning client with no visit in atRiskDays
 * Defaults (1 visit / 60 days) reproduce the previous hardcoded behaviour, so
 * nothing changes until a salon edits this. Each tap saves both values.
 */
export function ClientSegmentSettings({
  slug,
  initialNewMaxVisits,
  initialAtRiskDays,
}: Props) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const [newMax, setNewMax] = useState(initialNewMaxVisits);
  const [atRisk, setAtRisk] = useState(initialAtRiskDays);
  const [pending, startTransition] = useTransition();

  function save(nextNewMax: number, nextAtRisk: number) {
    const prevNew = newMax;
    const prevRisk = atRisk;
    setNewMax(nextNewMax);
    setAtRisk(nextAtRisk);
    startTransition(async () => {
      const res = await updateClientSegmentSettings(slug, {
        newMaxVisits: nextNewMax,
        atRiskDays: nextAtRisk,
      });
      if (!res.ok) {
        setNewMax(prevNew);
        setAtRisk(prevRisk);
      }
    });
  }

  const chip = (on: boolean) =>
    `rounded-full border px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
      on
        ? "border-nq-primary bg-nq-primary/15 text-nq-primary"
        : "border-nq-border/40 text-nq-muted hover:border-nq-primary/40"
    }`;

  return (
    <section
      data-testid="settings-client-segments"
      className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      <p className="text-sm font-semibold text-nq-foreground">
        {vi ? "Phân loại khách (Mới / Thường xuyên / Có nguy cơ)" : "Client segments (New / Regular / At-risk)"}
      </p>
      <p className="mt-0.5 text-xs text-nq-muted">
        {vi
          ? "Cách trang Khách hàng xếp nhóm. Khách dưới/bằng số lần ghé này là “Mới”; khách quen không quay lại trong số ngày này là “Có nguy cơ rời”. VIP do bạn tự đánh dấu."
          : "How the Clients page buckets customers. At or below this many visits = “New”; a returning client with no visit within this many days = “At-risk”. VIP is a manual flag."}
      </p>

      {/* New: max visits */}
      <p className="mt-4 text-xs font-medium text-nq-muted">
        {vi ? "“Mới” khi số lần ghé ≤" : "“New” when visits ≤"}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {VISIT_PRESETS.map((v) => (
          <button
            key={v}
            type="button"
            disabled={pending}
            onClick={() => save(v, atRisk)}
            className={chip(newMax === v)}
          >
            {v}
          </button>
        ))}
      </div>

      {/* At-risk: days since last visit */}
      <p className="mt-4 text-xs font-medium text-nq-muted">
        {vi ? "“Có nguy cơ rời” sau (ngày không ghé)" : "“At-risk” after (days with no visit)"}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {DAY_PRESETS.map((d) => (
          <button
            key={d}
            type="button"
            disabled={pending}
            onClick={() => save(newMax, d)}
            className={chip(atRisk === d)}
          >
            {d} {vi ? "ngày" : "days"}
          </button>
        ))}
      </div>
    </section>
  );
}
