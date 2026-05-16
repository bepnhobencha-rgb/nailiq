"use client";

import { KNOWN_AUDIT_ACTIONS } from "@/shared/superadmin/superadminTypes";

/**
 * URL-driven filter bar for the audit-log viewer (Phase 1F step 5).
 *
 * Uses a native `<form method="GET">` so submission rewrites the URL
 * directly — no router calls, no client state machine. The page is a
 * server component that reads `searchParams`, so the form's GET
 * submission is exactly the right primitive.
 *
 * Multi-select for `actions` uses a `<select multiple>` so the OS
 * provides the affordance without a new UI primitive. Power user
 * surface, not a customer-facing one.
 */

const TARGET_KINDS = [
  "salon",
  "service_category",
  "platform_flag",
  "services",
  "staff",
] as const;

type Props = {
  basePath: string;
  current: {
    actions?: readonly string[];
    actorUserId?: string;
    targetKinds?: readonly string[];
    from?: string;
    to?: string;
  };
  actorOptions: ReadonlyArray<{ id: string; email: string }>;
};

export function AuditLogFilterBar({ basePath, current, actorOptions }: Props) {
  const selectedActions = new Set(current.actions ?? []);
  const selectedKinds = new Set(current.targetKinds ?? []);

  return (
    <form
      method="GET"
      action={basePath}
      className="flex flex-col gap-4 rounded-2xl border border-nq-border/40 bg-nq-surface/40 px-4 py-4"
      data-testid="superadmin-audit-filter-bar"
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-nq-muted">
            Action
          </span>
          <select
            multiple
            name="action"
            size={5}
            className="rounded-md border border-nq-border/40 bg-nq-bg/40 px-2 py-1.5 text-sm text-nq-foreground"
            data-testid="superadmin-audit-filter-action"
            defaultValue={Array.from(selectedActions)}
          >
            {KNOWN_AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-nq-muted">
            Target kind
          </span>
          <select
            multiple
            name="kind"
            size={5}
            className="rounded-md border border-nq-border/40 bg-nq-bg/40 px-2 py-1.5 text-sm text-nq-foreground"
            data-testid="superadmin-audit-filter-kind"
            defaultValue={Array.from(selectedKinds)}
          >
            {TARGET_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-nq-muted">
            Actor
          </span>
          <select
            name="actor"
            className="rounded-md border border-nq-border/40 bg-nq-bg/40 px-2 py-1.5 text-sm text-nq-foreground"
            data-testid="superadmin-audit-filter-actor"
            defaultValue={current.actorUserId ?? ""}
          >
            <option value="">(any actor)</option>
            {actorOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-nq-muted">
            Date range (UTC)
          </span>
          <input
            type="date"
            name="from"
            defaultValue={current.from?.slice(0, 10) ?? ""}
            className="rounded-md border border-nq-border/40 bg-nq-bg/40 px-2 py-1.5 text-sm text-nq-foreground"
            data-testid="superadmin-audit-filter-from"
            aria-label="From"
          />
          <input
            type="date"
            name="to"
            defaultValue={current.to?.slice(0, 10) ?? ""}
            className="rounded-md border border-nq-border/40 bg-nq-bg/40 px-2 py-1.5 text-sm text-nq-foreground"
            data-testid="superadmin-audit-filter-to"
            aria-label="To"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="rounded-md bg-nq-primary px-4 py-2 text-sm font-medium text-nq-bg hover:opacity-90"
          data-testid="superadmin-audit-filter-apply"
        >
          Apply filters
        </button>
        <a
          href={basePath}
          className="text-sm text-nq-muted underline-offset-4 hover:underline"
          data-testid="superadmin-audit-filter-clear"
        >
          Clear all
        </a>
      </div>
    </form>
  );
}
