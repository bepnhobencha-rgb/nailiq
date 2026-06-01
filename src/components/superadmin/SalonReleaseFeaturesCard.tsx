import { cn } from "@/shared/lib/cn";
import {
  describeReleaseFeaturesForSalon,
  type ReleaseFeatureResolution,
  type ReleaseFeatureUiGroup,
} from "@/shared/features/featureRegistry";
import type { SuperAdminSalonDetail } from "@/shared/superadmin/superadminTypes";

/**
 * Read-only resolved-release-state panel for a single salon
 * (`/superadmin/salons/[salonId]`, rendered under `SalonOverrideCard`).
 *
 * This card has NO write controls — no toggles, no save, no reset. It simply
 * mirrors what `isReleaseFeatureEnabled` resolves for this salon so an operator
 * can read the effective state and where it came from without inferring it from
 * the mutation card above. All state derives from the pure
 * `describeReleaseFeaturesForSalon` helper.
 *
 * Release flags answer "is this surface shipped/enabled?" — a separate concern
 * from billing (see the explicit copy below and docs/FEATURE_FLAGS.md).
 */

const GROUP_META: Record<
  ReleaseFeatureUiGroup,
  { title: string; hint: string }
> = {
  base: {
    title: "Base",
    hint: "Customer-ready surfaces — default ON.",
  },
  beta: {
    title: "Beta",
    hint: "Unfinished / opt-in surfaces — default OFF.",
  },
  plan_column: {
    title: "Plan / Column-controlled",
    hint: "Resolved from the billing plan or the dedicated voice column, not the feature_flags jsonb.",
  },
};

const GROUP_ORDER: ReleaseFeatureUiGroup[] = ["base", "beta", "plan_column"];

const SOURCE_LABEL: Record<ReleaseFeatureResolution["source"], string> = {
  jsonb: "jsonb",
  column: "column",
  plan: "plan",
  registry: "registry",
};

export function SalonReleaseFeaturesCard({
  salon,
}: {
  salon: SuperAdminSalonDetail;
}) {
  const groups = describeReleaseFeaturesForSalon(salon);

  return (
    <section
      data-testid="superadmin-salon-release-features"
      className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-5"
    >
      <header className="mb-4">
        <h2 className="text-base font-semibold tracking-tight text-nq-foreground">
          Release features (resolved)
        </h2>
        <p className="mt-0.5 text-xs text-nq-muted">
          Read-only — the effective state of each release surface for this
          salon. Edit values in the Overrides card above.
        </p>
        <p
          data-testid="release-features-billing-note"
          className="mt-2 rounded-lg border border-nq-border/40 bg-nq-bg/40 px-3 py-2 text-xs text-nq-muted"
        >
          Release flags control product visibility, not billing.
        </p>
      </header>

      <div className="space-y-3">
        {GROUP_ORDER.map((group) => (
          <FeatureGroup
            key={group}
            group={group}
            rows={groups[group]}
          />
        ))}
      </div>
    </section>
  );
}

function FeatureGroup({
  group,
  rows,
}: {
  group: ReleaseFeatureUiGroup;
  rows: ReleaseFeatureResolution[];
}) {
  const meta = GROUP_META[group];
  return (
    <section
      data-testid={`release-group-${group}`}
      className="rounded-xl border border-nq-border/35 bg-nq-bg/30 p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
          {meta.title}
        </h3>
        <p className="text-[10px] leading-snug text-nq-muted/80">{meta.hint}</p>
      </div>
      <ul className="mt-2 grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <FeatureRow key={row.key} row={row} />
        ))}
      </ul>
    </section>
  );
}

function FeatureRow({ row }: { row: ReleaseFeatureResolution }) {
  return (
    <li
      data-testid={`release-feature-${row.key}`}
      data-resolved={row.resolved ? "on" : "off"}
      data-overridden={row.overridden ? "true" : "false"}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-sm",
        row.resolved
          ? "border-nq-primary/30 bg-nq-primary/5"
          : "border-nq-border/40 bg-nq-surface/30",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="block font-medium text-nq-foreground">
            {row.label}
          </span>
          <span className="mt-0.5 block font-mono text-[10px] text-nq-muted/80">
            {row.key}
          </span>
        </div>
        <StateBadge on={row.resolved} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-nq-muted">
          default {row.defaultOn ? "ON" : "OFF"}
        </span>
        <SourceBadge source={row.source} />
        {row.overridden ? <OverrideBadge featureKey={row.key} /> : null}
      </div>
    </li>
  );
}

function StateBadge({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
        on
          ? "border-nq-success/45 bg-nq-success/15 text-nq-success"
          : "border-nq-border/50 bg-nq-bg/50 text-nq-muted",
      )}
    >
      {on ? "ON" : "OFF"}
    </span>
  );
}

function SourceBadge({
  source,
}: {
  source: ReleaseFeatureResolution["source"];
}) {
  return (
    <span
      data-testid={`release-source-${source}`}
      className="rounded-full border border-nq-border/45 bg-nq-bg/55 px-1.5 py-0.5 font-mono text-[10px] text-nq-muted"
    >
      {SOURCE_LABEL[source]}
    </span>
  );
}

function OverrideBadge({ featureKey }: { featureKey: string }) {
  return (
    <span
      data-testid={`release-override-${featureKey}`}
      className="rounded-full border border-nq-primary/45 bg-nq-primary/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-nq-primary"
    >
      Override
    </span>
  );
}
