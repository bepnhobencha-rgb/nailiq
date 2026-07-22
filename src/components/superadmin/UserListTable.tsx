"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { cn } from "@/shared/lib/cn";
import type { SuperAdminUserRow } from "@/shared/superadmin/superadminTypes";

type SortKey = "lastSignIn" | "createdAt" | "email";

function formatRelative(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-CA");
}

function liveStatus(lastSignInAt: string | null): "live" | "today" | "week" | "dormant" {
  if (!lastSignInAt) return "dormant";
  const diff = Date.now() - new Date(lastSignInAt).getTime();
  if (diff < 15 * 60 * 1000) return "live";
  if (diff < 24 * 60 * 60 * 1000) return "today";
  if (diff < 7 * 24 * 60 * 60 * 1000) return "week";
  return "dormant";
}

const STATUS_DOT: Record<ReturnType<typeof liveStatus>, string> = {
  live: "bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.5)]",
  today: "bg-amber-400",
  week: "bg-sky-400",
  dormant: "bg-nq-border",
};

const STATUS_LABEL: Record<ReturnType<typeof liveStatus>, string> = {
  live: "Live",
  today: "Today",
  week: "This week",
  dormant: "Dormant",
};

const ROLE_BADGE: Record<string, string> = {
  owner: "bg-nq-primary/15 text-nq-primary",
  admin: "bg-sky-500/15 text-sky-400",
  manager: "bg-violet-500/15 text-violet-400",
  staff: "bg-nq-border/60 text-nq-muted",
};

function SortButton({
  sortKey,
  label,
  active,
  onSelect,
}: {
  sortKey: SortKey;
  label: string;
  active: boolean;
  onSelect: (sortKey: SortKey) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onSelect(sortKey)}
      className={cn(
        "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "border-nq-primary/40 bg-nq-primary/10 text-nq-primary"
          : "border-nq-border bg-nq-surface text-nq-muted hover:text-nq-foreground",
      )}
    >
      {label}
    </button>
  );
}

export function UserListTable({ users }: { users: SuperAdminUserRow[] }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("lastSignIn");

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return users
      .filter((u) => {
        if (!q) return true;
        if (u.email.toLowerCase().includes(q)) return true;
        return u.memberships.some(
          (m) =>
            m.salonName.toLowerCase().includes(q) ||
            m.salonSlug.toLowerCase().includes(q) ||
            m.role.toLowerCase().includes(q),
        );
      })
      .sort((a, b) => {
        if (sort === "email") return a.email.localeCompare(b.email);
        if (sort === "createdAt") {
          return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
        }
        // lastSignIn (default)
        const ta = a.lastSignInAt ?? a.createdAt ?? "";
        const tb = b.lastSignInAt ?? b.createdAt ?? "";
        return tb.localeCompare(ta);
      });
  }, [users, query, sort]);

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          placeholder="Search by email, salon, role…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-9 w-full max-w-xs rounded-lg border border-nq-border bg-nq-bg px-3 text-sm text-nq-foreground placeholder:text-nq-muted focus:outline-none focus:ring-2 focus:ring-nq-primary/40"
        />
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-xs text-nq-muted">Sort:</span>
          <SortButton
            sortKey="lastSignIn"
            label="Last active"
            active={sort === "lastSignIn"}
            onSelect={setSort}
          />
          <SortButton
            sortKey="createdAt"
            label="Joined"
            active={sort === "createdAt"}
            onSelect={setSort}
          />
          <SortButton
            sortKey="email"
            label="Email"
            active={sort === "email"}
            onSelect={setSort}
          />
        </div>
      </div>

      {/* Count */}
      <p className="text-xs text-nq-muted">
        {filtered.length} of {users.length} users
      </p>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-nq-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-nq-border bg-nq-surface/60">
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-nq-muted">
                Status
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-nq-muted">
                Email
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-nq-muted">
                Salon(s) / Role
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-nq-muted">
                Last active
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-nq-muted">
                Joined
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-nq-border/50">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-nq-muted">
                  No users match your search.
                </td>
              </tr>
            ) : (
              filtered.map((user) => {
                const status = liveStatus(user.lastSignInAt);
                return (
                  <tr
                    key={user.id}
                    className="group transition-colors hover:bg-nq-surface/60"
                  >
                    {/* Status dot */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "h-2.5 w-2.5 shrink-0 rounded-full",
                            STATUS_DOT[status],
                          )}
                        />
                        <span className="hidden text-xs text-nq-muted sm:inline">
                          {STATUS_LABEL[status]}
                        </span>
                      </div>
                    </td>

                    {/* Email */}
                    <td className="max-w-[220px] px-4 py-3">
                      <span className="truncate font-mono text-xs text-nq-foreground">
                        {user.email}
                      </span>
                    </td>

                    {/* Memberships */}
                    <td className="px-4 py-3">
                      {user.memberships.length === 0 ? (
                        <span className="text-xs text-nq-muted/60">
                          No salon
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {user.memberships.map((m) => (
                            <Link
                              key={`${m.salonId}-${m.role}`}
                              href={`/superadmin/salons/${m.salonId}`}
                              className="group/badge inline-flex items-center gap-1 rounded-full border border-nq-border px-2 py-0.5 text-[11px] transition-colors hover:border-nq-primary/40"
                            >
                              <span className="text-nq-foreground group-hover/badge:text-nq-primary">
                                {m.salonName || m.salonSlug}
                              </span>
                              <span
                                className={cn(
                                  "rounded-full px-1.5 py-px text-[10px] font-medium",
                                  ROLE_BADGE[m.role] ?? ROLE_BADGE.staff,
                                )}
                              >
                                {m.role}
                              </span>
                            </Link>
                          ))}
                        </div>
                      )}
                    </td>

                    {/* Last active */}
                    <td className="px-4 py-3 tabular-nums text-xs text-nq-muted">
                      {formatRelative(user.lastSignInAt)}
                    </td>

                    {/* Joined */}
                    <td className="px-4 py-3 tabular-nums text-xs text-nq-muted">
                      {user.createdAt
                        ? new Date(user.createdAt).toLocaleDateString("en-CA")
                        : "—"}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
