"use client";

import { SalonOwnerStatPill } from "@/components/dashboard/SalonOwnerStatPill";
import { Card } from "@/components/ui/Card";
import {
  formatSalonMoney,
  type SalonOwnerDashboardViewPayload,
} from "@/components/dashboard/salonDashboardFormat";
import { getUserMessages } from "@/shared/i18n/user";

// Inline 16px stroke icons — keep the bundle lean (no icon lib import) and
// inherit currentColor so the accent tint flows through.
const ico = {
  viewBox: "0 0 24 24",
  width: 16,
  height: 16,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function CalendarIcon() {
  return (
    <svg {...ico} aria-hidden>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M3 10h18M8 2v4M16 2v4" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg {...ico} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg {...ico} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12l3 3 5-6" />
    </svg>
  );
}
function SparkIcon() {
  return (
    <svg {...ico} aria-hidden>
      <path d="M12 3l1.8 4.5L18 9l-4.2 1.5L12 15l-1.8-4.5L6 9l4.2-1.5L12 3z" />
    </svg>
  );
}
function DollarIcon() {
  return (
    <svg {...ico} width={18} height={18} aria-hidden>
      <path d="M12 3v18M8 8a3 3 0 013-3h2a3 3 0 010 6h-2a3 3 0 000 6h2a3 3 0 003-3" />
    </svg>
  );
}

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
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SalonOwnerStatPill
          label={t.totalToday}
          value={String(data.stats.totalToday)}
          icon={<CalendarIcon />}
        />
        <SalonOwnerStatPill
          label={t.pending}
          value={String(data.stats.pending)}
          accent="gold"
          icon={<ClockIcon />}
        />
        <SalonOwnerStatPill
          label={t.confirmed}
          value={String(data.stats.confirmed)}
          accent="blue"
          icon={<CheckIcon />}
        />
        <SalonOwnerStatPill
          label={t.completed}
          value={String(data.stats.completed)}
          accent="green"
          icon={<SparkIcon />}
        />
      </div>

      {/* Revenue hero — the headline number gets its own gold-tinted card. */}
      <Card
        variant="elevated"
        padding="md"
        className="mt-2 ring-1 ring-nq-primary/20"
      >
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-nq-primary/12 text-nq-primary"
          >
            <DollarIcon />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-nq-muted">
              {t.estRevenue}
            </p>
            <p className="mt-0.5 text-2xl font-semibold tabular-nums text-nq-primary">
              {formatSalonMoney(data.stats.revenueCents, language)}
            </p>
          </div>
        </div>
      </Card>
    </section>
  );
}
