"use client";

import { useCallback, useState } from "react";
import {
  findDuplicateClients,
  mergeClientProfilesAction,
  type DedupeSuggestion,
} from "@/shared/dashboard/clientDedupeActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

const COPY = {
  en: {
    title: "Merge duplicate clients",
    subtitle:
      "Same person under more than one record (different numbers, name variants). Review and merge — history and visits combine into the one you keep.",
    scan: "Scan for duplicates",
    scanning: "Scanning…",
    aiToggle: "Use AI ranking",
    none: "No likely duplicates found. ✨",
    visits: (n: number) => `${n} visits`,
    keep: "Keep this one",
    merge: "Merge",
    merging: "Merging…",
    merged: "Merged ✓",
    match: "match",
    error: "Something went wrong. Try again.",
    suggestedName: (n: string) => `Suggested name: ${n}`,
  },
  vi: {
    title: "Gộp khách trùng",
    subtitle:
      "Cùng một người nhưng có nhiều hồ sơ (số khác nhau, tên viết khác). Xem và gộp — lịch sử & lượt ghé dồn về hồ sơ bạn giữ.",
    scan: "Quét khách trùng",
    scanning: "Đang quét…",
    aiToggle: "Dùng AI xếp hạng",
    none: "Không thấy hồ sơ trùng. ✨",
    visits: (n: number) => `${n} lần ghé`,
    keep: "Giữ hồ sơ này",
    merge: "Gộp",
    merging: "Đang gộp…",
    merged: "Đã gộp ✓",
    match: "khớp",
    error: "Có lỗi xảy ra. Thử lại.",
    suggestedName: (n: string) => `Tên gợi ý: ${n}`,
  },
};

type Row = DedupeSuggestion & {
  keepId: string;
  status: "idle" | "merging" | "done";
};

function maskPhone(phone: string): string {
  return `··· ${phone.slice(-4)}`;
}

export function ClientDedupePanel({ slug }: { slug: string }) {
  const { language } = useUserLanguage();
  const tx = COPY[language === "vi" ? "vi" : "en"];

  const [loading, setLoading] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [useAi, setUseAi] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState(false);

  const scan = useCallback(async () => {
    setLoading(true);
    setError(false);
    const res = await findDuplicateClients(slug, {
      useAi,
      lang: language === "vi" ? "vi" : "en",
    });
    setLoading(false);
    setScanned(true);
    if (!res.ok) {
      setError(true);
      setRows([]);
      return;
    }
    setRows(
      res.suggestions.map((s) => ({
        ...s,
        // Default to keeping the record with more visits (richer history).
        keepId: s.a.visitCount >= s.b.visitCount ? s.a.id : s.b.id,
        status: "idle" as const,
      })),
    );
  }, [slug, useAi, language]);

  const doMerge = useCallback(
    async (idx: number) => {
      const row = rows[idx];
      if (!row || row.status !== "idle") return;
      const dropId = row.keepId === row.a.id ? row.b.id : row.a.id;
      setRows((prev) =>
        prev.map((r, i) => (i === idx ? { ...r, status: "merging" } : r)),
      );
      const res = await mergeClientProfilesAction(slug, row.keepId, dropId, {
        renameTo: row.suggestedName,
      });
      setRows((prev) =>
        prev.map((r, i) =>
          i === idx ? { ...r, status: res.ok ? "done" : "idle" } : r,
        ),
      );
    },
    [rows, slug],
  );

  return (
    <section className="mb-6 rounded-2xl border border-nq-border bg-nq-surface p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-nq-text">{tx.title}</h2>
          <p className="mt-1 max-w-2xl text-xs text-nq-muted">{tx.subtitle}</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-nq-muted">
            <input
              type="checkbox"
              checked={useAi}
              onChange={(e) => setUseAi(e.target.checked)}
            />
            {tx.aiToggle}
          </label>
          <button
            type="button"
            onClick={scan}
            disabled={loading}
            className="rounded-lg bg-nq-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
          >
            {loading ? tx.scanning : tx.scan}
          </button>
        </div>
      </div>

      {error ? (
        <p className="mt-3 text-sm text-nq-error">{tx.error}</p>
      ) : null}

      {scanned && !loading && rows.length === 0 && !error ? (
        <p className="mt-3 text-sm text-nq-muted">{tx.none}</p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {rows.map((row, idx) => {
            const pct = Math.round(row.score * 100);
            return (
              <li
                key={`${row.a.id}-${row.b.id}`}
                className="rounded-xl border border-nq-border/60 p-3"
              >
                <div className="mb-2 flex items-center gap-2 text-xs text-nq-muted">
                  <span className="rounded-full bg-nq-primary/10 px-2 py-0.5 font-medium text-nq-primary">
                    {pct}% {tx.match}
                  </span>
                  <span>· {row.reason}</span>
                  {row.suggestedName ? (
                    <span className="truncate">
                      · {tx.suggestedName(row.suggestedName)}
                    </span>
                  ) : null}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {[row.a, row.b].map((c) => {
                    const isKeep = row.keepId === c.id;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        disabled={row.status !== "idle"}
                        onClick={() =>
                          setRows((prev) =>
                            prev.map((r, i) =>
                              i === idx ? { ...r, keepId: c.id } : r,
                            ),
                          )
                        }
                        className={`rounded-lg border p-2.5 text-left transition ${
                          isKeep
                            ? "border-nq-primary bg-nq-primary/5"
                            : "border-nq-border/60 opacity-70 hover:opacity-100"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium text-nq-text">
                            {c.name || "—"}
                            {c.isVip ? (
                              <span className="ml-1 text-amber-500">★</span>
                            ) : null}
                          </span>
                          {isKeep ? (
                            <span className="shrink-0 text-[10px] font-semibold uppercase text-nq-primary">
                              {tx.keep}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 text-xs text-nq-muted">
                          {maskPhone(c.phone)} · {tx.visits(c.visitCount)}
                          {c.email ? ` · ${c.email}` : ""}
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => doMerge(idx)}
                    disabled={row.status !== "idle"}
                    className="rounded-lg border border-nq-primary px-3 py-1.5 text-sm font-medium text-nq-primary disabled:opacity-60"
                  >
                    {row.status === "merging"
                      ? tx.merging
                      : row.status === "done"
                        ? tx.merged
                        : tx.merge}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
