"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { cn } from "@/shared/lib/cn";
import type { SuperAdminSalonRow } from "@/shared/superadmin/superadminTypes";

type SortKey =
  | "name"
  | "slug"
  | "plan"
  | "created"
  | "bookings_month";
type SortDir = "asc" | "desc";

const CREATED_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

function effectivePlan(row: SuperAdminSalonRow): string {
  return row.plan_override ?? row.subscription_plan ?? "free";
}

function formatCreated(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return CREATED_FORMATTER.format(d);
}

function compare<T>(a: T, b: T): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * Read-only salon list for `/superadmin/salons` (Phase 1D).
 *
 * Client-side search + sort — `loadAllSalons` returns the full set
 * in one trip; with < 100 salons in the foreseeable horizon, paging
 * isn't worth the URL plumbing. Clicking a row navigates to the
 * detail page (`/superadmin/salons/[salonId]`) where overrides
 * live.
 */
export function SalonListTable({
  salons,
}: {
  salons: SuperAdminSalonRow[];
}) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("created");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return salons;
    return salons.filter((s) => {
      return (
        s.name.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q) ||
        (s.admin_notes ?? "").toLowerCase().includes(q)
      );
    });
  }, [salons, query]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      let result: number;
      switch (sortKey) {
        case "name":
          result = compare(a.name || a.slug, b.name || b.slug);
          break;
        case "slug":
          result = compare(a.slug, b.slug);
          break;
        case "plan":
          result = compare(effectivePlan(a), effectivePlan(b));
          break;
        case "bookings_month":
          result = compare(a.bookings_this_month, b.bookings_this_month);
          break;
        case "created":
        default:
          result = compare(a.created_at, b.created_at);
          break;
      }
      return sortDir === "asc" ? result : -result;
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  function onHeaderClick(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "bookings_month" || key === "created" ? "desc" : "asc");
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-[0.18em] text-nq-muted uppercase">
            SuperAdmin · Salons
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-nq-foreground">
            Salons{" "}
            <span className="text-nq-muted text-base font-normal">
              ({salons.length})
            </span>
          </h1>
        </div>
        <Link
          href="/superadmin/salons-legacy"
          className="text-xs font-medium text-nq-muted underline-offset-4 hover:text-nq-foreground hover:underline"
        >
          Legacy panel (global flags) →
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="relative flex-1 min-w-[220px]">
          <span className="sr-only">Search salons</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, slug, or admin notes…"
            data-testid="superadmin-salons-search"
            className="block w-full rounded-lg border border-nq-border/50 bg-nq-bg/85 px-3 py-2 text-sm text-nq-foreground outline-none placeholder:text-nq-muted/70 focus-visible:border-nq-primary/80"
          />
        </label>
        <p className="text-xs text-nq-muted">
          {sorted.length === salons.length
            ? null
            : `${sorted.length} of ${salons.length} match`}
        </p>
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 px-5 py-8 text-center text-sm text-nq-muted">
          {salons.length === 0
            ? "No salons registered yet."
            : "No salons match your search."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-nq-border/40 bg-nq-surface/40">
          <table
            data-testid="superadmin-salons-table"
            className="w-full min-w-[760px] border-separate border-spacing-0 text-sm"
          >
            <thead className="bg-nq-bg/40 text-left text-xs uppercase tracking-wide text-nq-muted">
              <tr>
                <HeaderCell
                  label="Name"
                  active={sortKey === "name"}
                  dir={sortDir}
                  onClick={() => onHeaderClick("name")}
                />
                <HeaderCell
                  label="Slug"
                  active={sortKey === "slug"}
                  dir={sortDir}
                  onClick={() => onHeaderClick("slug")}
                />
                <HeaderCell
                  label="Plan"
                  active={sortKey === "plan"}
                  dir={sortDir}
                  onClick={() => onHeaderClick("plan")}
                />
                <HeaderCell
                  label="Created"
                  active={sortKey === "created"}
                  dir={sortDir}
                  onClick={() => onHeaderClick("created")}
                />
                <HeaderCell
                  label="Bookings (mo)"
                  active={sortKey === "bookings_month"}
                  dir={sortDir}
                  onClick={() => onHeaderClick("bookings_month")}
                  numeric
                />
                <th className="border-b border-nq-border/40 px-4 py-2.5">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <SalonRow key={s.id} salon={s} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function HeaderCell({
  label,
  active,
  dir,
  onClick,
  numeric = false,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  numeric?: boolean;
}) {
  return (
    <th
      className={cn(
        "border-b border-nq-border/40 px-4 py-2.5",
        numeric && "text-right",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "inline-flex items-center gap-1 font-semibold tracking-wide transition-colors",
          active ? "text-nq-foreground" : "text-nq-muted hover:text-nq-foreground",
        )}
      >
        {label}
        {active ? (
          <span aria-hidden className="text-nq-muted">
            {dir === "asc" ? "▲" : "▼"}
          </span>
        ) : null}
      </button>
    </th>
  );
}

function SalonRow({ salon }: { salon: SuperAdminSalonRow }) {
  const plan = effectivePlan(salon);
  const planIsOverride = salon.plan_override != null;
  const detailHref = `/superadmin/salons/${encodeURIComponent(salon.id)}`;
  return (
    <tr
      data-testid={`superadmin-salons-row-${salon.slug}`}
      className="group cursor-pointer transition-colors hover:bg-nq-bg/30"
    >
      <td className="border-b border-nq-border/30 px-4 py-3">
        <Link
          href={detailHref}
          className="block font-medium text-nq-foreground group-hover:text-nq-primary"
        >
          {salon.name || "(unnamed)"}
          {salon.is_beta ? (
            <span className="ml-2 inline-block rounded-full border border-nq-primary/40 bg-nq-primary/10 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-nq-primary uppercase">
              BETA
            </span>
          ) : null}
        </Link>
      </td>
      <td className="border-b border-nq-border/30 px-4 py-3 font-mono text-xs text-nq-muted">
        <Link href={detailHref} className="block">
          /{salon.slug}
        </Link>
      </td>
      <td className="border-b border-nq-border/30 px-4 py-3">
        <Link href={detailHref} className="block">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase",
              planIsOverride
                ? "border-nq-primary/45 bg-nq-primary/10 text-nq-primary"
                : "border-nq-border/45 bg-nq-bg/45 text-nq-muted",
            )}
          >
            {plan}
            {planIsOverride ? <span aria-hidden>★</span> : null}
          </span>
        </Link>
      </td>
      <td className="border-b border-nq-border/30 px-4 py-3 text-nq-muted">
        <Link href={detailHref} className="block">
          {formatCreated(salon.created_at)}
        </Link>
      </td>
      <td className="border-b border-nq-border/30 px-4 py-3 text-right tabular-nums text-nq-foreground">
        <Link href={detailHref} className="block">
          {salon.bookings_this_month}
        </Link>
      </td>
      <td className="border-b border-nq-border/30 px-4 py-3">
        <Link href={detailHref} className="block text-nq-muted">
          {salon.admin_notes ? (
            <span className="line-clamp-1 max-w-[180px] text-xs">
              {salon.admin_notes}
            </span>
          ) : (
            <span className="text-nq-muted/60">—</span>
          )}
        </Link>
      </td>
    </tr>
  );
}
