import type { AgentCertificationContractView } from "@/shared/superadmin/agentCertificationActions";

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

function ContractList({ items }: { items: string[] }) {
  return (
    <ul className="mt-1 list-disc space-y-1 pl-4">
      {items.map((item) => <li key={item}>{item}</li>)}
    </ul>
  );
}

export function AgentCertificationContractDetails({
  agentLabel,
  contract,
}: {
  agentLabel: string;
  contract: AgentCertificationContractView;
}) {
  const ledger = contract.costPolicy.ledgerFeatures.length > 0
    ? ` Ledger: ${contract.costPolicy.ledgerFeatures.join(", ")}.`
    : "";
  return (
    <details className="mt-2 rounded-lg border border-nq-border/40 bg-nq-surface/40 px-3 py-2">
      <summary
        aria-label={`View certification contract for ${agentLabel}`}
        className="cursor-pointer font-medium text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary"
      >
        View certification contract
      </summary>
      <dl className="mt-3 grid gap-3 text-xs leading-5 text-nq-muted sm:grid-cols-2">
        <div>
          <dt className="font-semibold text-nq-foreground">Trigger</dt>
          <dd>{contract.trigger.summary} · {humanize(contract.trigger.kind)} · fresh for {contract.trigger.freshnessHours}h</dd>
        </div>
        <div>
          <dt className="font-semibold text-nq-foreground">Effect level</dt>
          <dd>{humanize(contract.effectLevel)}</dd>
        </div>
        <div>
          <dt className="font-semibold text-nq-foreground">Permission contract</dt>
          <dd><ContractList items={contract.permissionContract} /></dd>
        </div>
        <div>
          <dt className="font-semibold text-nq-foreground">Inputs</dt>
          <dd><ContractList items={contract.inputs} /></dd>
        </div>
        <div>
          <dt className="font-semibold text-nq-foreground">Outputs</dt>
          <dd><ContractList items={contract.outputs} /></dd>
        </div>
        <div>
          <dt className="font-semibold text-nq-foreground">Audit contract</dt>
          <dd><ContractList items={contract.auditContract} /></dd>
        </div>
        <div>
          <dt className="font-semibold text-nq-foreground">Retry policy</dt>
          <dd><ContractList items={contract.retryPolicy} /></dd>
        </div>
        <div>
          <dt className="font-semibold text-nq-foreground">Cost policy</dt>
          <dd>{humanize(contract.costPolicy.kind)} · {contract.costPolicy.summary}.{ledger}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="font-semibold text-nq-foreground">Runtime evidence predicate</dt>
          <dd>{humanize(contract.runtimeEvidencePredicate.category)} · {contract.runtimeEvidencePredicate.summary}</dd>
        </div>
      </dl>
    </details>
  );
}
