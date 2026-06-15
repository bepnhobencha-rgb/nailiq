"use client";

import { useCallback, useEffect, useState } from "react";
import {
  loadTopHosts,
  setHostVip,
  type TopHost,
} from "@/shared/dashboard/topHostsActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

const COPY = {
  en: {
    title: "Top group hosts",
    subtitle:
      "Customers who bring the most guests via group bookings — your best connectors. Reward them with one tap.",
    brought: (g: number, n: number) =>
      `brought ${g} guest${g === 1 ? "" : "s"} · ${n} group booking${n === 1 ? "" : "s"}`,
    giveVip: "Make VIP",
    isVip: "★ VIP",
    saving: "…",
  },
  vi: {
    title: "Top người dẫn nhóm",
    subtitle:
      "Khách kéo nhiều người nhất qua đặt nhóm — người dẫn khách giá trị nhất. Tặng VIP chỉ 1 chạm.",
    brought: (g: number, n: number) => `đã dẫn ${g} khách · ${n} lần nhóm`,
    giveVip: "Tặng VIP",
    isVip: "★ VIP",
    saving: "…",
  },
};

function initials(name: string | null): string {
  const t = (name ?? "").trim();
  if (!t) return "?";
  const p = t.split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? "") + (p.length > 1 ? p[p.length - 1]![0] : "")).toUpperCase() || "?";
}

type Row = TopHost & { pending: boolean };

export function TopHostsPanel({ slug }: { slug: string }) {
  const { language } = useUserLanguage();
  const tx = COPY[language === "vi" ? "vi" : "en"];

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    let cancelled = false;
    void loadTopHosts(slug).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.ok) setRows(res.hosts.map((h) => ({ ...h, pending: false })));
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const toggleVip = useCallback(
    (idx: number) => {
      const row = rows[idx];
      if (!row || row.pending) return;
      const next = !row.isVip;
      setRows((prev) =>
        prev.map((r, i) => (i === idx ? { ...r, isVip: next, pending: true } : r)),
      );
      void setHostVip(slug, row.phone, next).then((res) => {
        setRows((prev) =>
          prev.map((r, i) =>
            i === idx ? { ...r, isVip: res.ok ? next : !next, pending: false } : r,
          ),
        );
      });
    },
    [rows, slug],
  );

  // Hide entirely until we know there's at least one host — no empty clutter.
  if (loading || rows.length === 0) return null;

  return (
    <section className="mb-6 rounded-2xl border border-nq-border bg-nq-surface p-4 md:p-5">
      <h2 className="text-base font-semibold text-nq-text">🎀 {tx.title}</h2>
      <p className="mt-1 max-w-2xl text-xs text-nq-muted">{tx.subtitle}</p>

      <ul className="mt-4 space-y-2">
        {rows.map((h, idx) => (
          <li
            key={h.phone}
            className="flex items-center gap-3 rounded-xl border border-nq-border/50 px-3 py-2.5"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-nq-primary/10 text-xs font-semibold text-nq-primary ring-1 ring-nq-primary/30">
              {initials(h.name)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-nq-text">
                  {h.name || "—"}
                </span>
                {h.isVip ? (
                  <span className="shrink-0 text-amber-500" title="VIP">
                    ★
                  </span>
                ) : null}
              </div>
              <span className="block truncate text-xs text-nq-muted">
                👥 {tx.brought(h.guestsBrought, h.groupsOrganized)} · ··· {h.phone.slice(-4)}
              </span>
            </div>
            <button
              type="button"
              disabled={h.pending}
              onClick={() => toggleVip(idx)}
              className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                h.isVip
                  ? "border-amber-500/50 bg-amber-500/10 text-amber-500"
                  : "border-nq-primary/50 text-nq-primary hover:bg-nq-primary/10"
              }`}
            >
              {h.pending ? tx.saving : h.isVip ? tx.isVip : `⭐ ${tx.giveVip}`}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
