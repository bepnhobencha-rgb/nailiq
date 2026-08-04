import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { KPIWidget } from "@/components/ui/KPIWidget";
import {
  loadAiCostDashboard,
  type BudgetState,
} from "@/shared/superadmin/aiCostActions";

export const dynamic = "force-dynamic";

const budgetLabel: Record<BudgetState, string> = {
  unconfigured: "No budget",
  ok: "Within budget",
  warning: "Near budget",
  exceeded: "Budget exceeded",
};

const budgetVariant: Record<BudgetState, BadgeVariant> = {
  unconfigured: "neutral",
  ok: "success",
  warning: "warning",
  exceeded: "danger",
};

const usd = (value: number) => `$${value.toFixed(4)}`;

export default async function AiCostsPage() {
  const result = await loadAiCostDashboard();

  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-8 md:px-8">
      <nav className="text-xs font-medium uppercase tracking-[0.18em] text-nq-muted">
        SuperAdmin · AI Ops
      </nav>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-nq-foreground">
        AI Cost Ledger
      </h1>
      <p className="mt-2 max-w-3xl text-sm text-nq-muted">
        Internal, PII-free model usage estimates. Budget states are alerts only;
        they never throttle or change salon AI behavior. Provider billing remains
        authoritative.
      </p>

      {!result.ok ? (
        <Card className="mt-6 border-nq-error/40 bg-nq-error/10">
          <p className="text-sm text-nq-error">
            Cost telemetry is unavailable. Verify the additive migration and
            service-role configuration.
          </p>
        </Card>
      ) : (
        <>
          <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KPIWidget label="Estimated spend" value={usd(result.data.estimatedCostUsd)} />
            <KPIWidget label="Tracked calls" value={result.data.calls} />
            <KPIWidget
              label="Failed calls"
              value={result.data.failedCalls}
              status={result.data.failedCalls > 0 ? "warning" : "default"}
            />
            <KPIWidget
              label="Unpriced calls"
              value={result.data.unpricedCalls}
              status={result.data.unpricedCalls > 0 ? "warning" : "default"}
            />
          </section>

          {result.data.truncated ? (
            <p className="mt-4 rounded-xl border border-nq-warning/40 bg-nq-warning/10 px-4 py-3 text-sm text-nq-warning">
              This month exceeds 10,000 ledger rows. Totals shown are partial.
            </p>
          ) : null}

          <section className="mt-8">
            <h2 className="text-base font-semibold text-nq-foreground">Salon budgets</h2>
            <p className="mt-1 text-xs text-nq-muted">
              Month begins {result.data.monthStart.slice(0, 10)} UTC. Missing
              budgets are reported, never invented.
            </p>
            <Card padding="none" className="mt-4 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="bg-nq-surface/70 text-xs uppercase tracking-wide text-nq-muted">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Salon</th>
                      <th className="px-4 py-3 font-semibold">Calls</th>
                      <th className="px-4 py-3 font-semibold">Failures</th>
                      <th className="px-4 py-3 font-semibold">Est. spend</th>
                      <th className="px-4 py-3 font-semibold">Budget</th>
                      <th className="px-4 py-3 font-semibold">Alert</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.salons.map((salon) => (
                      <tr key={salon.salonId} className="border-t border-nq-border/30">
                        <td className="px-4 py-3">
                          <p className="font-medium text-nq-foreground">{salon.salonName}</p>
                          <p className="text-xs text-nq-muted">{salon.slug}</p>
                        </td>
                        <td className="px-4 py-3 tabular-nums text-nq-foreground">{salon.calls}</td>
                        <td className="px-4 py-3 tabular-nums text-nq-muted">{salon.failedCalls}</td>
                        <td className="px-4 py-3 tabular-nums text-nq-foreground">{usd(salon.estimatedCostUsd)}</td>
                        <td className="px-4 py-3 tabular-nums text-nq-muted">
                          {salon.monthlyBudgetUsd === null ? "—" : `$${salon.monthlyBudgetUsd.toFixed(2)}`}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={budgetVariant[salon.budgetState]} dot>
                            {budgetLabel[salon.budgetState]}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </section>

          <section className="mt-8">
            <h2 className="text-base font-semibold text-nq-foreground">By feature</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {result.data.byFeature.length === 0 ? (
                <Card><p className="text-sm text-nq-muted">No model calls recorded this month.</p></Card>
              ) : result.data.byFeature.map((feature) => (
                <Card key={feature.feature}>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="font-medium text-nq-foreground">{feature.feature}</p>
                      <p className="mt-1 text-xs text-nq-muted">{feature.calls} tracked calls</p>
                    </div>
                    <p className="font-semibold tabular-nums text-nq-foreground">{usd(feature.costUsd)}</p>
                  </div>
                </Card>
              ))}
            </div>
          </section>

          <section className="mt-8">
            <h2 className="text-base font-semibold text-nq-foreground">Outcome &amp; ROI</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-nq-muted">
              Rolling 30-day evidence chain: provider-accepted customer action →
              booking → completed appointment → attributed service revenue. Cost
              per conversion uses completed appointments only. “Accepted” does
              not claim final inbox delivery, and attribution does not prove
              causation. Wait at least 14–30 days before disabling an agent.
            </p>
            <Card padding="none" className="mt-4 overflow-hidden">
              {result.data.outcomeRoi.length === 0 ? (
                <p className="p-5 text-sm text-nq-muted">
                  Collecting the first outcome and cost observations. No agent
                  decision is ready yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1040px] text-left text-sm">
                    <thead className="bg-nq-surface/70 text-xs uppercase tracking-wide text-nq-muted">
                      <tr>
                        <th className="px-4 py-3 font-semibold">Salon / agent</th>
                        <th className="px-4 py-3 font-semibold">Accepted</th>
                        <th className="px-4 py-3 font-semibold">Booked</th>
                        <th className="px-4 py-3 font-semibold">Completed</th>
                        <th className="px-4 py-3 font-semibold">Revenue</th>
                        <th className="px-4 py-3 font-semibold">AI cost</th>
                        <th className="px-4 py-3 font-semibold">Cost / conversion</th>
                        <th className="px-4 py-3 font-semibold">Evidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.data.outcomeRoi.map((row) => (
                        <tr key={`${row.salonId}:${row.agent}`} className="border-t border-nq-border/30">
                          <td className="px-4 py-3">
                            <p className="font-medium text-nq-foreground">{row.salonName}</p>
                            <p className="text-xs text-nq-muted">{row.agentLabel}</p>
                          </td>
                          <td className="px-4 py-3 tabular-nums text-nq-foreground">{row.acceptedDeliveries}</td>
                          <td className="px-4 py-3 tabular-nums text-nq-foreground">{row.bookings}</td>
                          <td className="px-4 py-3 tabular-nums text-nq-foreground">{row.completedAppointments}</td>
                          <td className="px-4 py-3 tabular-nums text-nq-foreground">${row.attributedRevenueUsd.toFixed(2)}</td>
                          <td className="px-4 py-3 tabular-nums text-nq-foreground">{usd(row.estimatedAiCostUsd)}</td>
                          <td className="px-4 py-3 tabular-nums text-nq-foreground">
                            {row.costPerCompletedConversionUsd === null
                              ? "—"
                              : usd(row.costPerCompletedConversionUsd)}
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant={row.decisionReady ? "success" : "warning"} dot>
                              {row.decisionReady
                                ? `${row.observationDays}d · review allowed`
                                : `${row.observationDays}d · collecting`}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </section>
        </>
      )}
    </main>
  );
}
