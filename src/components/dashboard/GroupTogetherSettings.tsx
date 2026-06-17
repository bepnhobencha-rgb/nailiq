"use client";

import { useState, useTransition } from "react";
import { updateGroupTogetherThreshold } from "@/shared/dashboard/salonOwnerActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Props = {
  slug: string;
  initialMinutes: number;
};

// How far apart group members can start and still feel "together".
const PRESETS = [15, 30, 45, 60, 90] as const;

/**
 * Owner setting: the group-booking "togetherness" threshold. When a group
 * can't all fit one time, members starting within this spread are offered as
 * "still together" first; beyond it the flow suggests an all-together time.
 */
export function GroupTogetherSettings({ slug, initialMinutes }: Props) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const [minutes, setMinutes] = useState(initialMinutes);
  const [pending, startTransition] = useTransition();

  function change(next: number) {
    const prev = minutes;
    setMinutes(next);
    startTransition(async () => {
      const res = await updateGroupTogetherThreshold(slug, next);
      if (!res.ok) setMinutes(prev); // revert on failure
    });
  }

  const label = (m: number) =>
    m >= 60
      ? vi
        ? `${m / 60} giờ`
        : `${m / 60}h`
      : `${m} ${vi ? "phút" : "min"}`;

  return (
    <section
      data-testid="settings-group-together"
      className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      <p className="text-sm font-semibold text-nq-foreground">
        {vi ? "Nhóm — độ lệch vẫn coi là “cùng nhau”" : "Group — “together” window"}
      </p>
      <p className="mt-0.5 text-xs text-nq-muted">
        {vi
          ? "Khi cả nhóm không xếp được cùng một giờ, vài người lệch trong khoảng này vẫn được xem là cùng nhau (theo đợt). Lệch hơn thì gợi ý giờ cả nhóm cùng lúc."
          : "When a group can't all fit one time, members starting within this window still count as together (gentle waves). Beyond it, the flow suggests an all-together time."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {PRESETS.map((m) => {
          const on = minutes === m;
          return (
            <button
              key={m}
              type="button"
              disabled={pending}
              onClick={() => change(m)}
              className={`rounded-full border px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                on
                  ? "border-nq-primary bg-nq-primary/15 text-nq-primary"
                  : "border-nq-border/40 text-nq-muted hover:border-nq-primary/40"
              }`}
            >
              {label(m)}
            </button>
          );
        })}
      </div>
    </section>
  );
}
