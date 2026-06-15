"use client";

import { useState } from "react";
import { updateSquareSyncSettings } from "@/shared/noshow/noShowDashboardActions";

type Toggles = {
  sync_pull_create: boolean;
  sync_pull_update: boolean;
  sync_pull_cancel: boolean;
  sync_push_create: boolean;
  sync_push_update: boolean;
  sync_push_cancel: boolean;
};

type Props = {
  slug: string;
  isOwner: boolean;
  connected: boolean;
  merchantId?: string | null;
  locationId?: string | null;
  environment?: string | null;
  lastRunAt?: string | null;
  initial: Toggles;
};

const OPS: { key: "create" | "update" | "cancel"; label: string }[] = [
  { key: "create", label: "Thêm / Add" },
  { key: "update", label: "Sửa / Edit" },
  { key: "cancel", label: "Xóa / Cancel" },
];

/**
 * Admin control for the Square ↔ NailIQ appointment sync. A 2×3 matrix:
 * direction (pull = Square→NailIQ, push = NailIQ→Square) × operation
 * (add/edit/cancel). PULL defaults on; PUSH is opt-in because it writes the
 * salon's live Square calendar (and a mirrored booking can trigger Square's own
 * customer confirmation).
 */
export function SquareSyncCard({
  slug,
  isOwner,
  connected,
  merchantId,
  locationId,
  environment,
  lastRunAt,
  initial,
}: Props) {
  const [t, setT] = useState<Toggles>(initial);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof Toggles, val: boolean) =>
    setT((prev) => ({ ...prev, [key]: val }));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await updateSquareSyncSettings(slug, t);
      if (res.ok) setSavedAt(Date.now());
      else setError(res.error ?? "Không lưu được");
    } catch {
      setError("Không lưu được");
    } finally {
      setSaving(false);
    }
  }

  const lastRun = lastRunAt
    ? new Date(lastRunAt).toLocaleString("vi-VN", { hour12: false })
    : null;

  return (
    <section className="rounded-2xl border border-nq-border bg-nq-surface p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-nq-foreground">
            Đồng bộ lịch hẹn Square / Square sync
          </h2>
          <p className="mt-0.5 text-xs text-nq-muted">
            Chọn chiều nào và thao tác nào (thêm / sửa / xóa) được đồng bộ.
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
            connected
              ? "bg-emerald-500/15 text-emerald-500"
              : "bg-nq-border/40 text-nq-muted"
          }`}
        >
          {connected ? "● Đã kết nối / Connected" : "○ Chưa kết nối"}
        </span>
      </div>

      {connected && (
        <p className="mt-2 text-[11px] text-nq-muted">
          {merchantId ? `Merchant ${merchantId}` : ""}
          {locationId ? ` · Location ${locationId}` : ""}
          {environment ? ` · ${environment}` : ""}
          {lastRun ? ` · Chạy gần nhất: ${lastRun}` : ""}
        </p>
      )}

      {!connected ? (
        <p className="mt-4 rounded-xl bg-nq-border/20 p-3 text-sm text-nq-muted">
          Tiệm chưa kết nối Square. Kết nối Square trước thì các tùy chọn dưới
          mới có tác dụng.
        </p>
      ) : (
        <>
          <div className="mt-4 overflow-hidden rounded-xl border border-nq-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-nq-border/20 text-nq-muted">
                  <th className="px-3 py-2 text-left font-medium">Chiều</th>
                  {OPS.map((o) => (
                    <th key={o.key} className="px-3 py-2 text-center font-medium">
                      {o.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <Row
                  title="Square → NailIQ"
                  subtitle="nhận về"
                  disabled={!isOwner}
                  values={[t.sync_pull_create, t.sync_pull_update, t.sync_pull_cancel]}
                  onChange={[
                    (v) => set("sync_pull_create", v),
                    (v) => set("sync_pull_update", v),
                    (v) => set("sync_pull_cancel", v),
                  ]}
                  testidPrefix="pull"
                />
                <Row
                  title="NailIQ → Square"
                  subtitle="đẩy đi"
                  disabled={!isOwner}
                  values={[t.sync_push_create, t.sync_push_update, t.sync_push_cancel]}
                  onChange={[
                    (v) => set("sync_push_create", v),
                    (v) => set("sync_push_update", v),
                    (v) => set("sync_push_cancel", v),
                  ]}
                  testidPrefix="push"
                />
              </tbody>
            </table>
          </div>

          {(t.sync_push_create || t.sync_push_update || t.sync_push_cancel) && (
            <p className="mt-3 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
              ⚠️ Đẩy sang Square ghi vào lịch Square thật. Riêng <b>Thêm</b> có
              thể khiến Square tự gửi tin nhắn xác nhận cho khách — hãy chỉnh cài
              đặt thông báo trong Square để tránh khách nhận 2 lần.
            </p>
          )}

          {isOwner && (
            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                onClick={save}
                disabled={saving}
                data-testid="square-sync-save"
                className="rounded-xl bg-nq-primary px-4 py-2 text-sm font-semibold text-nq-bg disabled:opacity-50"
              >
                {saving ? "Đang lưu…" : "Lưu / Save"}
              </button>
              {savedAt && !error && (
                <span className="text-xs text-emerald-500">✓ Đã lưu</span>
              )}
              {error && <span className="text-xs text-nq-error">{error}</span>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Row({
  title,
  subtitle,
  values,
  onChange,
  disabled,
  testidPrefix,
}: {
  title: string;
  subtitle: string;
  values: boolean[];
  onChange: ((v: boolean) => void)[];
  disabled: boolean;
  testidPrefix: string;
}) {
  return (
    <tr className="border-t border-nq-border">
      <td className="px-3 py-3">
        <span className="font-medium text-nq-foreground">{title}</span>
        <span className="ml-1 text-[11px] text-nq-muted">({subtitle})</span>
      </td>
      {OPS.map((o, i) => (
        <td key={o.key} className="px-3 py-3 text-center">
          <input
            type="checkbox"
            checked={values[i]}
            disabled={disabled}
            data-testid={`square-sync-${testidPrefix}-${o.key}`}
            onChange={(e) => onChange[i](e.target.checked)}
            className="h-4 w-4 accent-nq-primary disabled:opacity-40"
          />
        </td>
      ))}
    </tr>
  );
}
