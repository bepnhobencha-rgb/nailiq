"use client";

import { useEffect, useState, useTransition } from "react";
import { cn } from "@/shared/lib/cn";
import { loadSalonSessions, type PresenceRow } from "@/shared/dashboard/presenceActions";

const POLL_MS = 30_000;

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 10) return "Just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function DeviceIcon({ type }: { type: string | null }) {
  if (type === "mobile")
    return (
      <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="5" y="2" width="14" height="20" rx="2" />
        <circle cx="12" cy="18" r="1" fill="currentColor" stroke="none" />
      </svg>
    );
  if (type === "tablet")
    return (
      <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="2" width="18" height="20" rx="2" />
        <circle cx="12" cy="18" r="0.75" fill="currentColor" stroke="none" />
      </svg>
    );
  // desktop
  return (
    <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function BatteryBar({ level }: { level: number | null }) {
  if (level === null) return <span className="text-xs text-nq-muted/50">—</span>;
  const color =
    level <= 20
      ? "bg-red-500"
      : level <= 40
        ? "bg-amber-400"
        : "bg-emerald-400";
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative h-2 w-12 overflow-hidden rounded-full bg-nq-border/50">
        <div
          className={cn("h-full rounded-full transition-all", color)}
          style={{ width: `${level}%` }}
        />
      </div>
      <span className="tabular-nums text-[11px] text-nq-muted">{level}%</span>
    </div>
  );
}

const ROLE_BADGE: Record<string, string> = {
  owner: "bg-nq-primary/15 text-nq-primary border-nq-primary/20",
  admin: "bg-sky-500/15 text-sky-400 border-sky-500/20",
  manager: "bg-violet-500/15 text-violet-400 border-violet-500/20",
  staff: "bg-nq-border/40 text-nq-muted border-nq-border/60",
  nail_tech: "bg-nq-border/40 text-nq-muted border-nq-border/60",
};

function pathLabel(p: string | null): string {
  if (!p) return "—";
  // Strip the /dashboard/[slug]/ prefix for readability
  const match = p.match(/^\/dashboard\/[^/]+\/?(.*)/);
  const rest = match?.[1] ?? p;
  if (!rest) return "Home";
  return rest
    .replace(/\//g, " › ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .slice(0, 40) || "Home";
}

function maskIp(ip: string | null): string {
  if (!ip) return "—";
  // Show first 3 octets of IPv4, mask last: 1.2.3.x
  const v4 = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.×`;
  // IPv6: show first 16 chars
  if (ip.includes(":")) return ip.slice(0, 16) + "…";
  return ip;
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-nq-border/60 px-6 py-16 text-center">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-nq-surface/80">
        <svg className="h-6 w-6 text-nq-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
        </svg>
      </div>
      <p className="text-sm font-medium text-nq-foreground">No active sessions</p>
      <p className="mt-1 text-xs text-nq-muted">
        Staff will appear here within 30 seconds of opening the dashboard.
      </p>
    </div>
  );
}

export function SalonSessionsPanel({
  slug,
  initialSessions,
}: {
  slug: string;
  initialSessions: PresenceRow[];
}) {
  const [sessions, setSessions] = useState<PresenceRow[]>(initialSessions);
  const [lastRefresh, setLastRefresh] = useState<Date>(() => new Date());
  const [, startTransition] = useTransition();

  const refresh = () => {
    startTransition(async () => {
      const result = await loadSalonSessions(slug);
      if (result.ok && result.sessions) {
        setSessions(result.sessions);
        setLastRefresh(new Date());
      }
    });
  };

  useEffect(() => {
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              sessions.length > 0
                ? "animate-pulse bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.4)]"
                : "bg-nq-border",
            )}
          />
          <span className="text-sm font-medium text-nq-foreground">
            {sessions.length === 0
              ? "No one online"
              : `${sessions.length} ${sessions.length === 1 ? "person" : "people"} online`}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-nq-muted">
            Updated {formatRelative(lastRefresh.toISOString())}
          </span>
          <button
            type="button"
            onClick={refresh}
            className="rounded-lg border border-nq-border bg-nq-surface px-3 py-1.5 text-xs text-nq-muted transition-colors hover:border-nq-primary/40 hover:text-nq-foreground"
          >
            Refresh
          </button>
        </div>
      </div>

      {sessions.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sessions.map((s) => (
            <SessionCard
              key={s.userId}
              session={s}
              observedAtMs={lastRefresh.getTime()}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionCard({
  session: s,
  observedAtMs,
}: {
  session: PresenceRow;
  observedAtMs: number;
}) {
  const secsAgo = (observedAtMs - new Date(s.lastSeenAt).getTime()) / 1000;
  const isLive = secsAgo < 60;

  return (
    <div className="rounded-xl border border-nq-border bg-nq-surface/60 p-4 space-y-3 transition-colors hover:border-nq-primary/30">
      {/* Name + role */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-nq-foreground">
            {s.memberName ?? s.email ?? "Unknown"}
          </p>
          {s.memberName && s.email && (
            <p className="truncate text-xs text-nq-muted">{s.email}</p>
          )}
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-px text-[10px] font-medium",
            ROLE_BADGE[s.role] ?? ROLE_BADGE.staff,
          )}
        >
          {s.role}
        </span>
      </div>

      {/* Divider */}
      <div className="border-t border-nq-border/40" />

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        {/* Device + browser */}
        <div>
          <span className="text-nq-muted/70">Device</span>
          <div className="mt-0.5 flex items-center gap-1.5 text-nq-foreground">
            <DeviceIcon type={s.deviceType} />
            <span className="capitalize">{s.deviceType ?? "desktop"}</span>
            {s.browser && <span className="text-nq-muted">· {s.browser}</span>}
          </div>
        </div>

        {/* IP */}
        <div>
          <span className="text-nq-muted/70">IP</span>
          <p className="mt-0.5 font-mono text-nq-foreground">{maskIp(s.ipAddress)}</p>
        </div>

        {/* Current page */}
        <div className="col-span-2">
          <span className="text-nq-muted/70">Page</span>
          <p className="mt-0.5 truncate text-nq-foreground">{pathLabel(s.currentPath)}</p>
        </div>

        {/* Battery */}
        <div className="col-span-2">
          <span className="text-nq-muted/70">Battery</span>
          <div className="mt-0.5">
            <BatteryBar level={s.batteryLevel} />
          </div>
        </div>
      </div>

      {/* Last seen */}
      <div className="flex items-center gap-1.5 pt-0.5">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            isLive
              ? "animate-pulse bg-emerald-400"
              : "bg-nq-muted/40",
          )}
        />
        <span className="text-[11px] text-nq-muted">
          {isLive ? "Active now" : `Last seen ${formatRelative(s.lastSeenAt)}`}
        </span>
      </div>
    </div>
  );
}
