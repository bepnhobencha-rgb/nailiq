"use client";

import { useCallback, useEffect, useState } from "react";
import {
  loadMultiNamePhones,
  setClientName,
  type MultiNamePhone,
} from "@/shared/dashboard/multiNamePhonesActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

const COPY = {
  en: {
    title: "One number, several names",
    subtitle:
      "These phones (family / shared line / typos) appear under more than one name. Phone is the customer — pick the main name to show.",
    sharedLine: (n: number, v: number) => `${n} names · ${v} visits`,
    pickHint: "Tap the main name:",
    saving: "…",
  },
  vi: {
    title: "Một số, nhiều tên",
    subtitle:
      "Các số này (gia đình / dùng chung / gõ sai) đang mang nhiều tên. Số là khách — chọn tên chính để hiển thị.",
    sharedLine: (n: number, v: number) => `${n} tên · ${v} lượt ghé`,
    pickHint: "Chạm tên chính:",
    saving: "…",
  },
};

type Row = MultiNamePhone & { pending: boolean };

export function MultiNamePhonePanel({ slug }: { slug: string }) {
  const { language } = useUserLanguage();
  const tx = COPY[language === "vi" ? "vi" : "en"];

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    let cancelled = false;
    void loadMultiNamePhones(slug).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.ok) setRows(res.phones.map((p) => ({ ...p, pending: false })));
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const pickName = useCallback(
    (idx: number, name: string) => {
      const row = rows[idx];
      if (!row || row.pending || row.profileName === name) return;
      const prev = row.profileName;
      setRows((r) =>
        r.map((x, i) => (i === idx ? { ...x, profileName: name, pending: true } : x)),
      );
      void setClientName(slug, row.phone, name).then((res) => {
        setRows((r) =>
          r.map((x, i) =>
            i === idx
              ? { ...x, profileName: res.ok ? name : prev, pending: false }
              : x,
          ),
        );
      });
    },
    [rows, slug],
  );

  // Hide until we know there's at least one multi-name phone — no empty clutter.
  if (loading || rows.length === 0) return null;

  return (
    <section className="mb-6 rounded-2xl border border-nq-border bg-nq-surface p-4 md:p-5">
      <h2 className="text-base font-semibold text-nq-text">📞 {tx.title}</h2>
      <p className="mt-1 max-w-2xl text-xs text-nq-muted">{tx.subtitle}</p>

      <ul className="mt-4 space-y-3">
        {rows.map((row, idx) => (
          <li
            key={row.phone}
            className="rounded-xl border border-nq-border/50 px-3 py-2.5"
          >
            <div className="mb-2 flex items-center gap-2 text-xs text-nq-muted">
              <span className="font-mono">··· {row.phone.slice(-4)}</span>
              <span>· {tx.sharedLine(row.distinctNames, row.totalVisits)}</span>
            </div>
            <p className="mb-1.5 text-[11px] text-nq-muted">{tx.pickHint}</p>
            <div className="flex flex-wrap gap-2">
              {row.variants.map((v) => {
                const active = row.profileName === v.name;
                return (
                  <button
                    key={v.name}
                    type="button"
                    disabled={row.pending}
                    onClick={() => pickName(idx, v.name)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                      active
                        ? "border-nq-primary bg-nq-primary/15 text-nq-primary"
                        : "border-nq-border/50 text-nq-text hover:border-nq-primary/40"
                    }`}
                  >
                    {active ? "✓ " : ""}
                    {v.name}
                    <span className="ml-1 text-nq-muted">({v.count})</span>
                  </button>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
