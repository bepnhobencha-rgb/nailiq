import Link from "next/link";
import {
  formatJsonbDiff,
  renderValueForDiff,
} from "@/shared/superadmin/auditDiff";
import {
  KNOWN_AUDIT_ACTIONS,
  type AuditLogRow,
  type KnownAuditAction,
} from "@/shared/superadmin/superadminTypes";

/**
 * Read-only audit log table (Phase 1F step 4).
 *
 * Server component. Renders the page slice handed in from
 * `loadSuperadminAuditLogs`. Sorting + pagination happen server-side
 * via cursor; this component is pure presentation.
 *
 * Step 6 adds the inline `<details>` diff expander row.
 */

const ACTION_LABEL: Record<KnownAuditAction, string> = {
  impersonate_enter: "Impersonate · Enter",
  impersonate_exit: "Impersonate · Exit",
  impersonate_expire: "Impersonate · Expire",
  salon_flags_set: "Salon flags set",
  record_restore: "Record restore",
  platform_flag_set: "Platform flag set",
  category_add: "Category add",
  category_update: "Category update",
  category_delete: "Category delete",
};

// Color hint per action verb. Keeps the table scannable without
// inventing new tokens — borrows nq-success / nq-error / nq-info.
const ACTION_TINT: Record<KnownAuditAction, string> = {
  impersonate_enter: "text-nq-info",
  impersonate_exit: "text-nq-muted",
  impersonate_expire: "text-nq-warning",
  salon_flags_set: "text-nq-info",
  record_restore: "text-nq-success",
  platform_flag_set: "text-nq-info",
  category_add: "text-nq-success",
  category_update: "text-nq-info",
  category_delete: "text-nq-error",
};

function isKnownAction(a: string): a is KnownAuditAction {
  return (KNOWN_AUDIT_ACTIONS as readonly string[]).includes(a);
}

function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function truncate(text: string | null, max = 60): string {
  if (!text) return "—";
  const t = text.trim();
  if (t.length === 0) return "—";
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

function shortId(id: string | null): string {
  if (!id) return "—";
  return id.slice(0, 8);
}

function DiffCell({ row }: { row: AuditLogRow }) {
  const hasBefore =
    row.beforeJsonb && Object.keys(row.beforeJsonb).length > 0;
  const hasAfter = row.afterJsonb && Object.keys(row.afterJsonb).length > 0;
  if (!hasBefore && !hasAfter) {
    return <span className="text-xs text-nq-muted">—</span>;
  }
  const diff = formatJsonbDiff(row.beforeJsonb, row.afterJsonb);

  return (
    <details
      className="group max-w-[28rem]"
      data-testid="superadmin-audit-diff"
    >
      <summary className="cursor-pointer select-none text-xs text-nq-accent underline-offset-4 hover:underline">
        View diff
      </summary>
      <div className="mt-3 flex flex-col gap-2 rounded-md border border-nq-border/30 bg-nq-bg/40 p-3 text-xs">
        <span className="inline-flex w-fit items-center rounded-md border border-nq-warning/40 bg-nq-warning/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-nq-warning">
          Contains tenant data
        </span>
        {diff.onlyBefore.length > 0 && (
          <div>
            <div className="font-medium text-nq-error">Removed</div>
            <ul className="ml-3 list-disc">
              {diff.onlyBefore.map((d) => (
                <li key={d.key}>
                  <span className="font-mono">{d.key}:</span>{" "}
                  <code className="text-nq-muted">
                    {renderValueForDiff(d.value)}
                  </code>
                </li>
              ))}
            </ul>
          </div>
        )}
        {diff.changed.length > 0 && (
          <div>
            <div className="font-medium text-nq-info">Changed</div>
            <ul className="ml-3 list-disc">
              {diff.changed.map((d) => (
                <li key={d.key}>
                  <span className="font-mono">{d.key}:</span>{" "}
                  <code className="text-nq-muted">
                    {renderValueForDiff(d.before)}
                  </code>{" "}
                  →{" "}
                  <code className="text-nq-foreground">
                    {renderValueForDiff(d.after)}
                  </code>
                </li>
              ))}
            </ul>
          </div>
        )}
        {diff.onlyAfter.length > 0 && (
          <div>
            <div className="font-medium text-nq-success">Added</div>
            <ul className="ml-3 list-disc">
              {diff.onlyAfter.map((d) => (
                <li key={d.key}>
                  <span className="font-mono">{d.key}:</span>{" "}
                  <code className="text-nq-foreground">
                    {renderValueForDiff(d.value)}
                  </code>
                </li>
              ))}
            </ul>
          </div>
        )}
        {diff.onlyBefore.length === 0 &&
          diff.changed.length === 0 &&
          diff.onlyAfter.length === 0 && (
            <span className="text-nq-muted">(no field changes detected)</span>
          )}
      </div>
    </details>
  );
}

export function AuditLogTable({ rows }: { rows: AuditLogRow[] }) {
  if (rows.length === 0) {
    return (
      <div
        className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 px-5 py-10 text-center text-sm text-nq-muted"
        data-testid="superadmin-audit-empty"
      >
        No audit events recorded yet.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-nq-border/40 bg-nq-surface/40">
      <table
        data-testid="superadmin-audit-table"
        className="w-full min-w-[900px] border-separate border-spacing-0 text-sm"
      >
        <thead className="bg-nq-bg/40 text-left text-xs uppercase tracking-wide text-nq-muted">
          <tr>
            <th className="border-b border-nq-border/40 px-4 py-2.5">When</th>
            <th className="border-b border-nq-border/40 px-4 py-2.5">Actor</th>
            <th className="border-b border-nq-border/40 px-4 py-2.5">Action</th>
            <th className="border-b border-nq-border/40 px-4 py-2.5">Target</th>
            <th className="border-b border-nq-border/40 px-4 py-2.5">Reason</th>
            <th className="border-b border-nq-border/40 px-4 py-2.5">Diff</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const knownAction = isKnownAction(row.action);
            const actionLabel = knownAction
              ? ACTION_LABEL[row.action as KnownAuditAction]
              : row.action;
            const actionTint = knownAction
              ? ACTION_TINT[row.action as KnownAuditAction]
              : "text-nq-foreground";
            const actor =
              row.actorEmail ??
              (row.actorUserId ? shortId(row.actorUserId) : "(deleted user)");
            const targetKindLabel = row.targetKind ?? "—";
            const targetIsSalon = row.targetKind === "salon" && row.targetId;
            return (
              <tr
                key={row.id}
                className="border-b border-nq-border/20 align-top"
                data-testid="superadmin-audit-row"
                data-action={row.action}
              >
                <td className="border-b border-nq-border/20 px-4 py-3 align-top">
                  <div className="font-mono text-xs text-nq-foreground">
                    {formatUtc(row.createdAt)}
                  </div>
                  <div className="text-xs text-nq-muted">
                    {formatRelative(row.createdAt)}
                  </div>
                </td>
                <td className="border-b border-nq-border/20 px-4 py-3 align-top">
                  <div className="text-nq-foreground">{actor}</div>
                  <div className="font-mono text-xs uppercase tracking-wide text-nq-muted">
                    {row.actorRole}
                  </div>
                </td>
                <td className="border-b border-nq-border/20 px-4 py-3 align-top">
                  <span className={`font-mono text-xs ${actionTint}`}>
                    {actionLabel}
                  </span>
                </td>
                <td className="border-b border-nq-border/20 px-4 py-3 align-top">
                  <div className="text-xs text-nq-muted">{targetKindLabel}</div>
                  {targetIsSalon ? (
                    <Link
                      href={`/superadmin/salons/${row.targetId}`}
                      className="font-mono text-xs text-nq-accent underline-offset-4 hover:underline"
                    >
                      {shortId(row.targetId)}
                    </Link>
                  ) : (
                    <span className="font-mono text-xs text-nq-foreground">
                      {shortId(row.targetId)}
                    </span>
                  )}
                </td>
                <td className="border-b border-nq-border/20 px-4 py-3 align-top text-nq-foreground">
                  <span title={row.reason ?? undefined}>
                    {truncate(row.reason)}
                  </span>
                </td>
                <td className="border-b border-nq-border/20 px-4 py-3 align-top">
                  <DiffCell row={row} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
