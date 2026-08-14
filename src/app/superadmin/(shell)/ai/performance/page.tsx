import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { KPIWidget } from "@/components/ui/KPIWidget";
import { AgentCertificationContractDetails } from "@/components/superadmin/AgentCertificationContractDetails";
import {
  loadAgentCertificationMatrix,
  type CertificationStatus,
} from "@/shared/superadmin/agentCertificationActions";

export const dynamic = "force-dynamic";

const statusLabel: Record<CertificationStatus, string> = {
  certified: "Certified",
  not_enough_evidence: "Not enough evidence",
  not_configured: "Not configured",
  failed: "Failed",
};

const statusVariant: Record<CertificationStatus, BadgeVariant> = {
  certified: "success",
  not_enough_evidence: "warning",
  not_configured: "neutral",
  failed: "danger",
};

function formatEvidenceDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Vancouver",
  }).format(new Date(value));
}

export default async function AiPerformancePage() {
  const result = await loadAgentCertificationMatrix();

  return (
    <main className="mx-auto w-full max-w-7xl px-5 py-8 md:px-8">
      <nav className="text-xs font-medium uppercase tracking-[0.18em] text-nq-muted">
        SuperAdmin · AI Ops
      </nav>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-nq-foreground">
        Agent Certification Matrix
      </h1>
      <p className="mt-2 max-w-4xl text-sm leading-6 text-nq-muted">
        Read-only evidence for each salon and AI surface. Certified means a
        per-agent evidence predicate passed inside that agent&apos;s cadence-aware
        freshness limit. Not enough evidence is not a failure; it means the
        required runtime proof is missing or stale. This page never runs an agent
        or sends customer communication.
      </p>

      {!result.ok ? (
        <Card className="mt-6 border-nq-error/40 bg-nq-error/10">
          <p className="text-sm text-nq-error">
            Certification evidence is unavailable. Verify SuperAdmin access and
            production telemetry.
          </p>
        </Card>
      ) : (
        <>
          <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KPIWidget label="Certified" value={result.data.counts.certified} />
            <KPIWidget label="Not enough evidence" value={result.data.counts.not_enough_evidence} status="warning" />
            <KPIWidget label="Not configured" value={result.data.counts.not_configured} />
            <KPIWidget label="Failed" value={result.data.counts.failed} status={result.data.counts.failed > 0 ? "danger" : "default"} />
          </section>

          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-nq-muted">
            <span>Window: {result.data.windowDays} days</span>
            <span>Generated: {formatEvidenceDate(result.data.generatedAt)}</span>
            <span>Latest Manager run: {formatEvidenceDate(result.data.latestManagerRunAt)}</span>
          </div>

          {result.data.truncated ? (
            <p className="mt-4 rounded-xl border border-nq-warning/40 bg-nq-warning/10 px-4 py-3 text-sm text-nq-warning">
              At least one evidence source reached 10,000 rows. Some counts may be partial.
            </p>
          ) : null}

          <div className="mt-8 space-y-7">
            {[...new Map(result.data.matrix.map((row) => [row.salonId, {
              id: row.salonId,
              name: row.salonName,
              slug: row.slug,
            }])).values()].map((salon) => {
              const rows = result.data.matrix.filter((row) => row.salonId === salon.id);
              const certified = rows.filter((row) => row.status === "certified").length;
              return (
                <section key={salon.id}>
                  <div className="flex flex-wrap items-end justify-between gap-2">
                    <div>
                      <h2 className="text-base font-semibold text-nq-foreground">{salon.name}</h2>
                      <p className="text-xs text-nq-muted">{salon.slug}</p>
                    </div>
                    <p className="text-xs font-medium text-nq-muted">{certified}/{rows.length} certified</p>
                  </div>
                  <Card padding="none" className="mt-3 overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[980px] text-left text-sm">
                        <caption className="sr-only">
                          Agent certification status and operating contracts for {salon.name}
                        </caption>
                        <thead className="bg-nq-surface/70 text-xs uppercase tracking-wide text-nq-muted">
                          <tr>
                            <th className="px-4 py-3 font-semibold">Agent</th>
                            <th className="px-4 py-3 font-semibold">Status</th>
                            <th className="px-4 py-3 font-semibold">Cadence</th>
                            <th className="px-4 py-3 font-semibold">Fresh / eligible</th>
                            <th className="px-4 py-3 font-semibold">Latest</th>
                            <th className="px-4 py-3 font-semibold">Evidence and contract</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row) => (
                            <tr key={row.agent} className="border-t border-nq-border/30 align-top">
                              <td className="px-4 py-3 font-medium text-nq-foreground">{row.agentLabel}</td>
                              <td className="px-4 py-3">
                                <Badge variant={statusVariant[row.status]} dot>{statusLabel[row.status]}</Badge>
                              </td>
                              <td className="px-4 py-3 text-nq-muted">{row.cadence}</td>
                              <td className="px-4 py-3 tabular-nums text-nq-foreground">{row.freshEvidenceCount} / {row.evidenceCount}</td>
                              <td className="px-4 py-3 whitespace-nowrap text-nq-muted">{formatEvidenceDate(row.lastEvidenceAt)}</td>
                              <td className="max-w-xl px-4 py-3 text-xs leading-5 text-nq-muted">
                                <p>{row.reason}</p>
                                <AgentCertificationContractDetails
                                  agentLabel={row.agentLabel}
                                  contract={row.contract}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                </section>
              );
            })}
          </div>
        </>
      )}
    </main>
  );
}
