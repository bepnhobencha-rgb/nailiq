"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  loadHostGroups,
  type HostGroup,
  type TopHost,
} from "@/shared/dashboard/topHostsActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

const COPY = {
  en: {
    title: "Group host",
    brought: (g: number, n: number) =>
      `🎀 brought ${g} guest${g === 1 ? "" : "s"} across ${n} group booking${n === 1 ? "" : "s"}`,
    groups: "Groups hosted",
    loading: "Loading…",
    none: "No groups yet.",
    withLabel: "with",
    guests: (n: number) => `${n} guests`,
    makeVip: "Make VIP",
    isVip: "★ VIP",
    fullProfile: "Open full profile",
    close: "Close",
  },
  vi: {
    title: "Người dẫn nhóm",
    brought: (g: number, n: number) => `🎀 đã dẫn ${g} khách qua ${n} lần nhóm`,
    groups: "Các nhóm đã dẫn",
    loading: "Đang tải…",
    none: "Chưa có nhóm nào.",
    withLabel: "đi cùng",
    guests: (n: number) => `${n} khách`,
    makeVip: "Tặng VIP",
    isVip: "★ VIP",
    fullProfile: "Xem hồ sơ đầy đủ",
    close: "Đóng",
  },
};

function fmtDate(iso: string | null, vi: boolean): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(vi ? "vi-VN" : "en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function HostDetailDrawer({
  slug,
  host,
  onClose,
  onToggleVip,
  onOpenFull,
}: {
  slug: string;
  host: TopHost | null;
  onClose: () => void;
  onToggleVip: () => void;
  onOpenFull: (phone: string) => void;
}) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const tx = COPY[vi ? "vi" : "en"];

  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only portal mount flag
  useEffect(() => setMounted(true), []);

  const [groups, setGroups] = useState<HostGroup[] | null>(null);
  const phone = host?.phone ?? null;
  useEffect(() => {
    let cancelled = false;
    // Reset to the loading state whenever the host changes, then fetch.
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale groups on host change before the async load */
    setGroups(null);
    if (phone) {
      void loadHostGroups(slug, phone).then((res) => {
        if (!cancelled) setGroups(res.ok ? res.groups : []);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [slug, phone]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!mounted || !host) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex justify-end">
      <button
        type="button"
        aria-label={tx.close}
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />
      <aside className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-nq-border bg-nq-surface shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-nq-border/50 p-4">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide text-nq-muted">{tx.title}</p>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-nq-text">
              {host.name || "—"}
              {host.isVip ? <span className="ml-1 text-amber-500">★</span> : null}
            </h2>
            <p className="mt-0.5 text-xs text-nq-muted">
              {tx.brought(host.guestsBrought, host.groupsOrganized)} · ··· {host.phone.slice(-4)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={tx.close}
            className="shrink-0 rounded-full p-1.5 text-nq-muted hover:text-nq-text"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 space-y-3 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
            {tx.groups}
          </p>
          {groups === null ? (
            <p className="text-sm text-nq-muted">{tx.loading}</p>
          ) : groups.length === 0 ? (
            <p className="text-sm text-nq-muted">{tx.none}</p>
          ) : (
            <ul className="space-y-2">
              {groups.map((g) => (
                <li
                  key={g.groupId}
                  className="rounded-xl border border-nq-border/50 px-3 py-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-nq-text">
                      {fmtDate(g.startedAt, vi)}
                    </span>
                    <span className="shrink-0 text-xs text-nq-muted">
                      {tx.guests(g.size)}
                    </span>
                  </div>
                  {g.service ? (
                    <p className="mt-0.5 text-xs text-nq-muted">{g.service}</p>
                  ) : null}
                  {g.attendees.length > 0 ? (
                    <p className="mt-1 text-xs text-nq-text">
                      <span className="text-nq-muted">{tx.withLabel}: </span>
                      {g.attendees.join(", ")}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-nq-border/50 p-4">
          <button
            type="button"
            onClick={onToggleVip}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
              host.isVip
                ? "border-amber-500/50 bg-amber-500/10 text-amber-500"
                : "border-nq-primary/50 text-nq-primary hover:bg-nq-primary/10"
            }`}
          >
            {host.isVip ? tx.isVip : `⭐ ${tx.makeVip}`}
          </button>
          <button
            type="button"
            onClick={() => onOpenFull(host.phone)}
            className="flex-1 rounded-lg bg-nq-primary px-3 py-2 text-sm font-medium text-white"
          >
            {tx.fullProfile}
          </button>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}
