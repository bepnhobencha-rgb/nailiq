import Link from "next/link";

/**
 * Cursor-based Next/Prev links for the audit-log viewer.
 *
 * The loader returns opaque cursors; this component only handles
 * the URL rewriting so the page stays a server component and remains
 * sharable via deep link.
 */

type Props = {
  basePath: string;
  baseSearchParams: Record<string, string | undefined>;
  nextCursor: string | null;
  prevCursor: string | null;
};

function buildHref(
  basePath: string,
  params: Record<string, string | undefined>,
  cursor: string | null,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v && k !== "cursor") sp.set(k, v);
  }
  if (cursor) sp.set("cursor", cursor);
  const qs = sp.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

export function AuditLogPager({
  basePath,
  baseSearchParams,
  nextCursor,
  prevCursor,
}: Props) {
  if (!nextCursor && !prevCursor) return null;
  return (
    <nav
      className="flex items-center justify-between gap-4 pt-2 text-sm"
      data-testid="superadmin-audit-pager"
      aria-label="Audit log pagination"
    >
      <div>
        {prevCursor ? (
          <Link
            href={buildHref(basePath, baseSearchParams, null)}
            className="text-nq-accent underline-offset-4 hover:underline"
            data-testid="superadmin-audit-pager-first"
          >
            ← Newest
          </Link>
        ) : (
          <span className="text-nq-muted">← Newest</span>
        )}
      </div>
      <div>
        {nextCursor ? (
          <Link
            href={buildHref(basePath, baseSearchParams, nextCursor)}
            className="text-nq-accent underline-offset-4 hover:underline"
            data-testid="superadmin-audit-pager-next"
          >
            Older →
          </Link>
        ) : (
          <span className="text-nq-muted">Older →</span>
        )}
      </div>
    </nav>
  );
}
