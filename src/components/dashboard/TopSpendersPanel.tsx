"use client";

import { useCallback, useEffect, useState } from "react";
import {
  loadTopSpenders,
  type TopSpender,
} from "@/shared/dashboard/topSpendersActions";
import { setHostVip } from "@/shared/dashboard/topHostsActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { ClientProfile360Drawer } from "@/components/dashboard/ClientProfile360Drawer";

const COPY = {
  en: {
    title: "Top spenders",
    subtitle:
      "Your biggest customers by money spent (synced from Square). Reward them with one tap.",
    visits: (n: number) => `${n} payment${n === 1 ? "" : "s"}`,
    last: "last",
    giveVip: "Make VIP",
    isVip: "★ VIP",
    saving: "…",
  },
  vi: {
    title: "Top khách chi tiêu",
    subtitle:
      "Khách chi nhiều tiền nhất (đồng bộ từ Square). Tặng VIP chỉ 1 chạm.",
    visits: (n: number) => `${n} lần trả`,
    last: "gần nhất",
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

function money(cents: number): string {
  return "$" + Math.round(cents / 100).toLocaleString("en-US");
}

type Row = TopSpender & { pending: boolean };

export function TopSpendersPanel({
  slug,
  viewerRole,
}: {
  slug: string;
  viewerRole: string;
}) {
  const { language } = useUserLanguage();
  const tx = COPY[language === "vi" ? "vi" : "en"];

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [open360, setOpen360] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadTopSpenders(slug).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.ok) setRows(res.spenders.map((s) => ({ ...s, pending: false })));
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

  // Hide until there's spend data (no empty clutter).
  if (loading || rows.length === 0) return null;

  return (
    <section className="mb-6 rounded-2xl border border-nq-border bg-nq-surface p-4 md:p-5">
      <h2 className="text-base font-semibold text-nq-text">💎 {tx.title}</h2>
      <p className="mt-1 max-w-2xl text-xs text-nq-muted">{tx.subtitle}</p>

      <ul className="mt-4 space-y-2">
        {rows.map((s, idx) => (
          <li
            key={s.phone}
            className="flex items-center gap-3 rounded-xl border border-nq-border/50 px-3 py-2.5 transition-colors hover:border-nq-primary/40"
          >
            <span className="w-5 shrink-0 text-center text-sm font-semibold text-nq-muted">
              {idx + 1}
            </span>
            <button
              type="button"
              onClick={() => setOpen360(s.phone)}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-nq-primary/10 text-xs font-semibold text-nq-primary ring-1 ring-nq-primary/30">
                {initials(s.name)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-nq-text">
                    {s.name || "—"}
                  </span>
                  {s.isVip ? (
                    <span className="shrink-0 text-amber-500" title="VIP">
                      ★
                    </span>
                  ) : null}
                </span>
                <span className="block truncate text-xs text-nq-muted">
                  {tx.visits(s.paymentCount)}
                  {s.lastPaymentAt ? ` · ${tx.last} ${s.lastPaymentAt.slice(0, 10)}` : ""} · ··· {s.phone.slice(-4)}
                </span>
              </span>
            </button>
            <span className="shrink-0 text-sm font-semibold text-nq-text tabular-nums">
              {money(s.totalSpendCents)}
            </span>
            <button
              type="button"
              disabled={s.pending}
              onClick={() => toggleVip(idx)}
              className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                s.isVip
                  ? "border-amber-500/50 bg-amber-500/10 text-amber-500"
                  : "border-nq-primary/50 text-nq-primary hover:bg-nq-primary/10"
              }`}
            >
              {s.pending ? tx.saving : s.isVip ? tx.isVip : `⭐ ${tx.giveVip}`}
            </button>
          </li>
        ))}
      </ul>

      <ClientProfile360Drawer
        slug={slug}
        clientPhone={open360}
        viewerRole={viewerRole}
        onClose={() => setOpen360(null)}
      />
    </section>
  );
}
