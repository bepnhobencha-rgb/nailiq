"use client";

import { Clock3, MoreHorizontal, Plus } from "lucide-react";

import type { QueueItem } from "@/components/receptionist/WalkinQueueSidebar";
import { displayCustomerName } from "@/shared/lib/customerDisplayName";

type AppleWalkinQueueProps = {
  items: QueueItem[];
  assigningId: string | null;
  nowIso: string;
  language: "en" | "vi";
  canAdd: boolean;
  onAdd: () => void;
  onAssign: (id: string) => void;
  onOpenFullQueue: () => void;
};

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function AppleWalkinQueue({
  items,
  assigningId,
  nowIso,
  language,
  canAdd,
  onAdd,
  onAssign,
  onOpenFullQueue,
}: AppleWalkinQueueProps) {
  const nowMs = Date.parse(nowIso);
  const title =
    language === "vi"
      ? `Hàng chờ · ${items.length}`
      : `Walk-in queue · ${items.length}`;

  return (
    <aside
      className="flex min-h-0 flex-col border-l border-[var(--rc-new-border)] bg-[var(--rc-new-surface)]"
      data-testid="preview-walkin-queue"
      aria-label={title}
    >
      <div className="flex min-h-16 items-center justify-between border-b border-[var(--rc-new-border)] px-5">
        <h2 className="text-base font-semibold text-[var(--rc-new-text)]">
          {title}
        </h2>
        <button
          type="button"
          onClick={onOpenFullQueue}
          className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-[var(--rc-new-muted)] hover:bg-[var(--rc-new-surface-subtle)] hover:text-[var(--rc-new-text)]"
          aria-label={
            language === "vi" ? "Mở đầy đủ hàng chờ" : "Open full queue"
          }
        >
          <MoreHorizontal className="h-5 w-5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center px-5 text-center">
            <p className="text-sm font-semibold text-[var(--rc-new-text)]">
              {language === "vi" ? "Không có khách chờ" : "No one waiting"}
            </p>
            <p className="mt-1 text-xs text-[var(--rc-new-muted)]">
              {language === "vi"
                ? "Khách vãng lai mới sẽ xuất hiện ở đây."
                : "New walk-ins will appear here."}
            </p>
          </div>
        ) : (
          items.map((item) => {
            const joinedMs = Date.parse(item.joined_queue_at);
            const waitMinutes =
              Number.isFinite(nowMs) && Number.isFinite(joinedMs)
                ? Math.max(0, Math.floor((nowMs - joinedMs) / 60_000))
                : 0;
            const active = assigningId === item.id;
            return (
              <article
                key={item.id}
                className="flex items-center gap-3 border-b border-[var(--rc-new-border-subtle)] px-5 py-4"
              >
                <span
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                >
                  {initials(item.client_name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-[var(--rc-new-text)]">
                    {displayCustomerName(
                      item.client_name,
                      language === "vi" ? "Khách đã xoá" : "Removed guest",
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-[var(--rc-new-muted)]">
                    {item.service_name}
                  </span>
                  <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-[var(--rc-new-muted)]">
                    <Clock3 className="h-3 w-3" aria-hidden />
                    {language === "vi"
                      ? `đợi ${waitMinutes} phút`
                      : `waiting ${waitMinutes} min`}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => onAssign(item.id)}
                  disabled={assigningId !== null && !active}
                  className={`inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg px-4 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
                    active
                      ? "bg-nq-info text-white"
                      : "bg-[var(--rc-new-control)] text-white hover:opacity-90"
                  }`}
                >
                  {active
                    ? language === "vi"
                      ? "Chọn giờ"
                      : "Pick time"
                    : language === "vi"
                      ? "Xếp thợ"
                      : "Assign"}
                </button>
              </article>
            );
          })
        )}
      </div>

      {canAdd ? (
        <div className="border-t border-[var(--rc-new-border)] p-4">
          <button
            type="button"
            onClick={onAdd}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-[var(--rc-new-border-strong)] bg-[var(--rc-new-surface)] px-4 text-sm font-semibold text-[var(--rc-new-text)] hover:bg-[var(--rc-new-surface-subtle)]"
          >
            <Plus className="h-4 w-4" />
            {language === "vi" ? "Khách vãng lai" : "Walk-in"}
          </button>
        </div>
      ) : null}
    </aside>
  );
}
