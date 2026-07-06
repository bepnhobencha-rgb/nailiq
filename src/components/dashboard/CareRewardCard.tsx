"use client";

import { useState, useTransition } from "react";
import {
  updateCareReward,
  type CareReward,
  type CareRewardKind,
} from "@/shared/loyalty/careRewardActions";

type Props = {
  slug: string;
  kind: CareRewardKind;
  title: string;
  description: string;
  initial: CareReward;
};

/** Owner sets an AI VIP Care reward (birthday or milestone gift). When set, that
 *  email attaches a real voucher code. */
export function CareRewardCard({ slug, kind, title, description, initial }: Props) {
  const [type, setType] = useState<CareReward["type"]>(initial.type);
  const [percent, setPercent] = useState<string>(initial.percent ? String(initial.percent) : "15");
  const [amount, setAmount] = useState<string>(
    initial.amountCents ? String(Math.round(initial.amountCents / 100)) : "10",
  );
  const [validDays, setValidDays] = useState<string>(String(initial.validDays || 30));
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function save() {
    setMsg(null);
    start(async () => {
      const res = await updateCareReward(slug, kind, {
        type,
        percent: type === "percent" ? Number(percent) : null,
        amountCents: type === "amount" ? Math.round(Number(amount) * 100) : null,
        validDays: Number(validDays),
      });
      setMsg(res.ok ? "Đã lưu ✓" : `Lỗi: ${res.error ?? "không lưu được"}`);
    });
  }

  return (
    <div className="rounded-xl border border-[var(--color-nq-border,#e5e5e5)] p-5">
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-[var(--color-nq-muted,#666)]">{description}</p>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="flex flex-col text-sm">
          <span className="mb-1 font-medium">Loại quà</span>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as CareReward["type"])}
            className="rounded-lg border border-[var(--color-nq-border,#e5e5e5)] px-3 py-2"
          >
            <option value="none">Không tặng</option>
            <option value="percent">Giảm %</option>
            <option value="amount">Giảm số tiền ($)</option>
          </select>
        </label>

        {type === "percent" && (
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium">Giảm (%)</span>
            <input
              type="number"
              min={1}
              max={100}
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
              className="w-24 rounded-lg border border-[var(--color-nq-border,#e5e5e5)] px-3 py-2"
            />
          </label>
        )}

        {type === "amount" && (
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium">Giảm ($)</span>
            <input
              type="number"
              min={1}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-24 rounded-lg border border-[var(--color-nq-border,#e5e5e5)] px-3 py-2"
            />
          </label>
        )}

        {type !== "none" && (
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium">Hạn dùng (ngày)</span>
            <input
              type="number"
              min={1}
              max={365}
              value={validDays}
              onChange={(e) => setValidDays(e.target.value)}
              className="w-24 rounded-lg border border-[var(--color-nq-border,#e5e5e5)] px-3 py-2"
            />
          </label>
        )}

        <button
          onClick={save}
          disabled={pending}
          className="rounded-lg bg-[var(--salon-primary,#1a1a1a)] px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Đang lưu…" : "Lưu"}
        </button>
      </div>

      {msg && <p className="mt-3 text-sm">{msg}</p>}
    </div>
  );
}
