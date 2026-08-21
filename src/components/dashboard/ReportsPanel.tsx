import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { KPIWidget } from "@/components/ui/KPIWidget";
import {
  type LoadSalonReportsResult,
  type ReportsDateRange,
  type ReportsSnapshot,
} from "@/shared/dashboard/loadSalonReports";
import { getUserMessages, type UserLanguage } from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";
import { formatCurrency, type Currency } from "@/shared/lib/currencyFormat";

/**
 * Owner-only reports panel.
 *
 * Sections (in order):
 *   A. Summary KPIs — revenue, appointments, completed, cancelled, no-show
 *   B. Top services table — name, count, revenue
 *   C. Top staff table — name, appointments, revenue
 *   D. Busy hours bar chart — CSS only (no chart library), visible
 *      hours window (`HOURS_START..HOURS_END`) per UX_PRINCIPLES §1
 *      "no decorative animation"; pure proportional bars.
 *
 * Reuses KPIWidget + Card + Badge from `src/components/ui/` per
 * ARCHITECTURE_LOCK §2.
 */

const HOURS_START = 9;
const HOURS_END = 20;

// P0.2 — currency-aware money formatter for the reports panel.
// Reads the salon's configured currency (CAD/USD/VND); falls back to
// CAD via parseCurrency upstream.
function formatMoney(cents: number, currency: Currency): string {
  return formatCurrency(cents, currency) ?? "—";
}

export interface ReportsPanelProps {
  slug: string;
  range: ReportsDateRange;
  result: LoadSalonReportsResult;
  language: UserLanguage;
  /** P0.2 — salon's configured currency. */
  currency: Currency;
  /** Studio-tier (`premium`) gate for the per-staff performance
   *  drill-down. Pro/Free salons see an upsell card instead. */
  hasStaffPerformance: boolean;
}

export function ReportsPanel({
  slug,
  range,
  result,
  language,
  currency,
  hasStaffPerformance,
}: ReportsPanelProps) {
  const messages = getUserMessages(language).receptionist.reports;
  const state:
    | { kind: "ok"; data: ReportsSnapshot }
    | {
        kind: "error";
        error: Extract<LoadSalonReportsResult, { ok: false }>["error"];
      } = result.ok
    ? { kind: "ok", data: result.data }
    : { kind: "error", error: result.error };

  const errorCopy =
    state.kind === "error"
      ? (messages.errors[state.error] ?? messages.errors.server_error)
      : null;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-nq-foreground">
        {messages.pageTitle}
      </h1>
      {/* Date-range selector */}
      <div
        role="tablist"
        aria-label={messages.rangeAriaLabel}
        data-testid="reports-range"
        className="inline-flex overflow-hidden rounded-md border border-nq-border bg-nq-surface text-xs font-medium"
      >
        {(["today", "week", "month"] as const).map((r) => {
          const active = range === r;
          return (
            <a
              key={r}
              role="tab"
              aria-selected={active}
              data-testid={`reports-range-${r}`}
              href={`/dashboard/${encodeURIComponent(slug)}/insights?range=${r}`}
              className={cn(
                "px-3 py-1.5 transition-colors",
                active
                  ? "bg-nq-primary/15 text-nq-primary"
                  : "text-nq-muted hover:text-nq-foreground",
              )}
            >
              {messages.range[r]}
            </a>
          );
        })}
      </div>

      <p
        data-testid="reports-estimated-value-notice"
        className="rounded-md border border-nq-border bg-nq-surface px-3 py-2 text-xs leading-relaxed text-nq-muted"
      >
        {messages.estimatedValueNotice}
      </p>

      {state.kind === "error" ? (
        <p
          role="alert"
          data-testid="reports-error"
          className="rounded-md border border-nq-error/40 bg-nq-error/10 px-3 py-2 text-sm text-nq-error"
        >
          {errorCopy}
        </p>
      ) : null}

      {/* A. Summary KPIs — KPIWidget primitive accepts a loading flag so
            we don't have to special-case the skeleton. */}
      <section
        data-testid="reports-kpis"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
      >
        <KPIWidget
          label={messages.kpis.totalRevenue}
          value={
            state.kind === "ok"
              ? formatMoney(state.data.totalRevenueCents, currency)
              : "—"
          }
        />
        <KPIWidget
          label={messages.kpis.appointments}
          value={
            state.kind === "ok" ? String(state.data.appointmentCount) : "—"
          }
        />
        <KPIWidget
          label={messages.kpis.completed}
          value={state.kind === "ok" ? String(state.data.completedCount) : "—"}
        />
        <KPIWidget
          label={messages.kpis.cancelled}
          value={state.kind === "ok" ? String(state.data.cancelledCount) : "—"}
        />
        <KPIWidget
          label={messages.kpis.noShow}
          value={state.kind === "ok" ? String(state.data.noShowCount) : "—"}
        />
      </section>

      {/* B. Top services table */}
      <Card variant="default" padding="md">
        <h2 className="mb-2 text-sm font-semibold text-nq-foreground">
          {messages.tables.topServices}
        </h2>
        {state.kind === "ok" && state.data.topServices.length === 0 ? (
          <p className="text-sm italic text-nq-muted">
            {messages.tables.empty}
          </p>
        ) : null}
        {state.kind === "ok" && state.data.topServices.length > 0 ? (
          <table className="w-full text-sm" data-testid="reports-top-services">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-nq-muted">
                <th className="py-1.5">{messages.tables.serviceCol}</th>
                <th className="py-1.5 text-right">
                  {messages.tables.countCol}
                </th>
                <th className="py-1.5 text-right">
                  {messages.tables.revenueCol}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-nq-border/50">
              {state.data.topServices.map((s) => (
                <tr key={s.name}>
                  <td className="py-1.5 text-nq-foreground">{s.name}</td>
                  <td className="py-1.5 text-right tabular-nums">{s.count}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {formatMoney(s.revenueCents, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>

      {/* B2. Bookings by source/channel */}
      <Card variant="default" padding="md">
        <h2 className="mb-2 text-sm font-semibold text-nq-foreground">
          {messages.tables.bySource}
        </h2>
        {state.kind === "ok" && state.data.channelMix.length === 0 ? (
          <p className="text-sm italic text-nq-muted">
            {messages.tables.empty}
          </p>
        ) : null}
        {state.kind === "ok" && state.data.channelMix.length > 0
          ? (() => {
              const total = state.data.channelMix.reduce(
                (sum, c) => sum + c.count,
                0,
              );
              return (
                <table
                  className="w-full text-sm"
                  data-testid="reports-by-source"
                >
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-nq-muted">
                      <th className="py-1.5">{messages.tables.sourceCol}</th>
                      <th className="py-1.5 text-right">
                        {messages.tables.countCol}
                      </th>
                      <th className="py-1.5 text-right">
                        {messages.tables.shareCol}
                      </th>
                      <th className="py-1.5 text-right">
                        {messages.tables.revenueCol}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-nq-border/50">
                    {state.data.channelMix.map((c) => (
                      <tr key={c.channel}>
                        <td className="py-1.5 text-nq-foreground">
                          {messages.channelLabels[
                            c.channel as keyof typeof messages.channelLabels
                          ] ?? c.channel}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {c.count}
                        </td>
                        <td className="py-1.5 text-right tabular-nums text-nq-muted">
                          {total > 0 ? Math.round((c.count / total) * 100) : 0}%
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {formatMoney(c.revenueCents, currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            })()
          : null}
      </Card>

      {/* C. Top staff table */}
      <Card variant="default" padding="md">
        <h2 className="mb-2 text-sm font-semibold text-nq-foreground">
          {messages.tables.topStaff}
        </h2>
        {state.kind === "ok" && state.data.topStaff.length === 0 ? (
          <p className="text-sm italic text-nq-muted">
            {messages.tables.empty}
          </p>
        ) : null}
        {state.kind === "ok" && state.data.topStaff.length > 0 ? (
          <table className="w-full text-sm" data-testid="reports-top-staff">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-nq-muted">
                <th className="py-1.5">{messages.tables.staffCol}</th>
                <th className="py-1.5 text-right">
                  {messages.tables.appointmentsCol}
                </th>
                <th className="py-1.5 text-right">
                  {messages.tables.revenueCol}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-nq-border/50">
              {state.data.topStaff.map((s) => (
                <tr key={s.name}>
                  <td className="py-1.5 text-nq-foreground">{s.name}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {s.appointmentCount}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {formatMoney(s.revenueCents, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>

      {/* C2. Staff performance — Studio-tier drill-down. Free/Pro see
            the upsell card; Studio (premium) sees the detail table. */}
      <Card variant="default" padding="md">
        <h2 className="mb-2 text-sm font-semibold text-nq-foreground">
          {messages.staffPerformance.title}
        </h2>
        {hasStaffPerformance ? (
          state.kind === "ok" && state.data.staffPerformance.length === 0 ? (
            <p className="text-sm italic text-nq-muted">
              {messages.staffPerformance.empty}
            </p>
          ) : state.kind === "ok" ? (
            <div className="overflow-x-auto">
              <table
                className="w-full min-w-[640px] text-sm"
                data-testid="reports-staff-performance"
              >
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-nq-muted">
                    <th className="py-1.5">
                      {messages.staffPerformance.col.staff}
                    </th>
                    <th className="py-1.5 text-right">
                      {messages.staffPerformance.col.appointments}
                    </th>
                    <th className="py-1.5 text-right">
                      {messages.staffPerformance.col.completion}
                    </th>
                    <th className="py-1.5 text-right">
                      {messages.staffPerformance.col.cancellation}
                    </th>
                    <th className="py-1.5 text-right">
                      {messages.staffPerformance.col.noShow}
                    </th>
                    <th className="py-1.5 text-right">
                      {messages.staffPerformance.col.revenue}
                    </th>
                    <th className="py-1.5 text-right">
                      {messages.staffPerformance.col.repeatClients}
                    </th>
                    <th className="py-1.5">
                      {messages.staffPerformance.col.topServices}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-nq-border/50">
                  {state.data.staffPerformance.map((s) => (
                    <tr key={s.staffId}>
                      <td className="py-1.5 text-nq-foreground">{s.name}</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {s.appointmentCount}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {Math.round(s.completionRate * 100)}%
                      </td>
                      <td
                        className={cn(
                          "py-1.5 text-right tabular-nums",
                          s.cancellationRate >= 0.15 && "text-nq-warning",
                        )}
                      >
                        {Math.round(s.cancellationRate * 100)}%
                      </td>
                      <td
                        className={cn(
                          "py-1.5 text-right tabular-nums",
                          s.noShowRate >= 0.1 && "text-nq-error",
                        )}
                      >
                        {Math.round(s.noShowRate * 100)}%
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatMoney(s.revenueCents, currency)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {s.repeatClientCount}
                      </td>
                      <td className="py-1.5 text-nq-muted">
                        {s.topServices
                          .map((t) => `${t.name} (${t.count})`)
                          .join(", ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-nq-muted">{messages.loading}</p>
          )
        ) : (
          <div className="flex flex-col gap-3 rounded-xl border border-nq-primary/30 bg-nq-primary/10 px-4 py-3 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-col gap-0.5">
              <p className="text-sm font-semibold text-nq-foreground">
                {messages.staffPerformance.upsellTitle}
              </p>
              <p className="text-sm text-nq-muted">
                {messages.staffPerformance.upsellBody}
              </p>
            </div>
            <a
              href={`/dashboard/${encodeURIComponent(slug)}/settings`}
              data-testid="reports-staff-performance-upsell"
              className="inline-flex items-center justify-center rounded-full bg-nq-primary px-4 py-2 text-sm font-semibold text-nq-bg hover:opacity-90"
            >
              {messages.staffPerformance.upsellCta}
            </a>
          </div>
        )}
      </Card>

      {/* D. Busy hours — CSS bars only, no chart library. Bars use
            transform-free width so layout shifts are bounded by the
            grid container. */}
      <Card variant="default" padding="md">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-nq-foreground">
            {messages.busyHours.title}
          </h2>
          {state.kind === "ok" && state.data.appointmentCount > 0 ? (
            <Badge variant="info" state="subtle" size="sm">
              {messages.busyHours.totalBookings.replace(
                "{n}",
                String(state.data.appointmentCount),
              )}
            </Badge>
          ) : null}
        </div>
        {state.kind === "ok" ? (
          <BusyHoursChart
            busyHours={state.data.busyHours}
            emptyLabel={messages.busyHours.empty}
          />
        ) : (
          <p className="text-sm text-nq-muted">{messages.loading}</p>
        )}
      </Card>
    </div>
  );
}

function BusyHoursChart({
  busyHours,
  emptyLabel,
}: {
  busyHours: ReportsSnapshot["busyHours"];
  emptyLabel: string;
}) {
  const visible = busyHours.filter(
    (h) => h.hour >= HOURS_START && h.hour < HOURS_END,
  );
  const max = visible.reduce((m, h) => (h.count > m ? h.count : m), 0);

  if (max === 0) {
    return (
      <p
        className="text-sm italic text-nq-muted"
        data-testid="reports-busy-empty"
      >
        {emptyLabel}
      </p>
    );
  }

  return (
    <div
      data-testid="reports-busy-hours"
      className="flex h-40 items-end gap-1.5"
    >
      {visible.map((h) => {
        const pct = max > 0 ? Math.round((h.count / max) * 100) : 0;
        const label = `${h.hour % 12 === 0 ? 12 : h.hour % 12}${
          h.hour < 12 ? "a" : "p"
        }`;
        return (
          <div
            key={h.hour}
            className="flex flex-1 flex-col items-center gap-1"
            data-testid={`reports-busy-${h.hour}`}
          >
            <span className="text-[10px] tabular-nums text-nq-muted">
              {h.count}
            </span>
            <div
              className="w-full rounded-sm bg-nq-primary/45"
              style={{ height: `${pct}%`, minHeight: pct > 0 ? 2 : 0 }}
              aria-label={`${h.count} bookings at ${label}`}
            />
            <span className="text-[10px] font-medium text-nq-muted">
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
