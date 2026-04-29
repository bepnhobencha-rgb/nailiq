"use client";

import { SalonOwnerStatPill } from "@/components/dashboard/SalonOwnerStatPill";
import {
  formatSalonMoney,
  type SalonOwnerDashboardViewPayload,
} from "@/components/dashboard/salonDashboardFormat";
import { getUserMessages } from "@/shared/i18n/user";

export function SalonOwnerStatsSection({
  data,
  language,
}: {
  data: SalonOwnerDashboardViewPayload;
  language: "en" | "vi";
}) {
  const t = getUserMessages(language).salonDashboard;

  return (
    <section className="mt-6" aria-label={t.todaySummary}>
      <h2 className="text-lg font-semibold text-nq-foreground">{t.todaySummary}</h2>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <SalonOwnerStatPill label={t.totalToday} value={String(data.stats.totalToday)} />
        <SalonOwnerStatPill
          label={t.pending}
          value={String(data.stats.pending)}
          accent="gold"
        />
        <SalonOwnerStatPill
          label={t.confirmed}
          value={String(data.stats.confirmed)}
          accent="blue"
          className="sm:col-span-1"
        />
        <SalonOwnerStatPill
          label={t.completed}
          value={String(data.stats.completed)}
          accent="green"
        />
        <div className="col-span-2 rounded-2xl border border-nq-border/35 bg-nq-surface/40 px-3 py-3 sm:col-span-3">
          <p className="text-[11px] font-medium text-nq-muted">{t.estRevenue}</p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums text-nq-primary">
            {formatSalonMoney(data.stats.revenueCents, language)}
          </p>
        </div>
      </div>
    </section>
  );
}
