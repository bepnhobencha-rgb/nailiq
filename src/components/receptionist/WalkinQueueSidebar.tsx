"use client";

import { cn } from "@/shared/lib/cn";
import { isWalkinUrgent, minutesWaiting } from "@/shared/lib/queueUrgency";

import { WalkinAddForm, type WalkinAddFormProps } from "./WalkinAddForm";

export interface QueueItem {
  id: string;
  client_name: string;
  client_phone: string | null;
  /** Service FK for ghost width / assignment span (caller supplies from loader row). */
  service_id: string;
  service_name: string;
  service_duration_minutes: number;
  staff_request_note: string | null;
  joined_queue_at: string;
}

export interface WalkinQueueSidebarProps {
  /** Queue items, already sorted FIFO by parent */
  items: QueueItem[];
  /** Currently being assigned (highlight that item, disable others) */
  assigningId: string | null;
  /** Services for the add form */
  services: WalkinAddFormProps["services"];
  /** Localized strings */
  labels: {
    title: string;
    addForm: WalkinAddFormProps["labels"];
    emptyMessage: string;
    cancelButton: string;
    assignButton: string;
    urgentBadge: string;
    waitingHint: string;
    minutesAgo: (n: number) => string;
  };
  /** Callbacks */
  onAddWalkin: WalkinAddFormProps["onSubmit"];
  onCancelWalkin: (bookingId: string) => Promise<void>;
  onStartAssign: (bookingId: string) => void;
  onCancelAssign: () => void;
  /** Current time for urgency calc — passed by parent so it can re-render every 60s */
  nowIso: string;
  /** Block add form when salon has no services or no staff */
  addFormDisabled?: boolean;
}

export function WalkinQueueSidebar({
  items,
  assigningId,
  services,
  labels,
  onAddWalkin,
  onCancelWalkin,
  onStartAssign,
  onCancelAssign,
  nowIso,
  addFormDisabled = false,
}: WalkinQueueSidebarProps) {
  const onAssignClick = (itemId: string) => {
    if (assigningId !== null && assigningId !== itemId) {
      onCancelAssign();
      onStartAssign(itemId);
      return;
    }
    onStartAssign(itemId);
  };

  return (
    <aside className="flex h-full min-h-0 flex-col bg-nq-surface">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-nq-muted/20 px-3 py-2">
        <h2 className="text-sm font-semibold text-nq-foreground">{labels.title}</h2>
        <span className="rounded-full bg-nq-primary/20 px-2.5 py-0.5 font-mono text-xs font-semibold tabular-nums text-nq-primary">
          {items.length}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3">
        <WalkinAddForm
          services={services}
          labels={labels.addForm}
          onSubmit={onAddWalkin}
          disabled={addFormDisabled}
        />

        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-nq-muted">
            <span className="text-lg text-nq-muted/80" aria-hidden>
              ↑
            </span>
            <p>{labels.emptyMessage}</p>
          </div>
        ) : (
          <ul className="mt-4 space-y-3 pb-4">
            {items.map((item) => {
              const waited = minutesWaiting(item.joined_queue_at, nowIso);
              const urgent = isWalkinUrgent({
                joinedQueueAtIso: item.joined_queue_at,
                staffRequestNote: item.staff_request_note,
                nowIso,
              });
              const assigningThis = assigningId === item.id;
              const blockOthers = assigningId !== null && !assigningThis;

              return (
                <li
                  key={item.id}
                  className="relative"
                  data-testid={`queue-item-${item.id}`}
                >
                  {assigningThis ? (
                    <p
                      className={cn(
                        "mb-1 rounded-md border border-nq-primary/40 bg-nq-primary/10 px-2 py-1 text-center text-[11px] font-semibold uppercase tracking-wide text-nq-primary",
                      )}
                    >
                      {labels.waitingHint}
                    </p>
                  ) : null}
                  <div
                    className={cn(
                      "rounded-xl border p-3 transition-[box-shadow,border-color] duration-[var(--duration-nq-fast,150ms)]",
                      assigningThis
                        ? "border-nq-primary shadow-[0_0_24px_-4px_color-mix(in_srgb,var(--color-nq-primary)_45%,transparent)]"
                        : urgent
                          ? "border-nq-error/55 bg-nq-error/[0.06]"
                          : "border-nq-muted/30 bg-nq-bg",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="truncate text-sm font-semibold text-nq-foreground">
                            {item.client_name}
                          </p>
                          {urgent ? (
                            <span
                              className={cn(
                                "shrink-0 rounded-md bg-nq-error/20 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-nq-error",
                              )}
                            >
                              ⚡ {labels.urgentBadge}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <span className="shrink-0 rounded-full bg-nq-muted/25 px-2 py-0.5 font-mono text-[10px] font-medium tabular-nums text-nq-muted">
                        {labels.minutesAgo(waited)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-nq-muted">
                      {item.service_name}
                      <span className="font-mono text-nq-muted/90">
                        {" "}
                        · {item.service_duration_minutes}m
                      </span>
                    </p>
                    {item.staff_request_note ? (
                      <p
                        className={cn(
                          "mt-2 border-l-[3px] border-nq-primary pl-2 text-sm text-nq-foreground/90",
                        )}
                      >
                        {item.staff_request_note}
                      </p>
                    ) : null}
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        disabled={blockOthers}
                        onClick={() => void onCancelWalkin(item.id)}
                        data-testid={`queue-cancel-${item.id}`}
                        className={cn(
                          "min-h-10 flex-1 rounded-lg border border-nq-muted/40 bg-transparent px-3 text-sm font-medium text-nq-muted transition-colors hover:border-nq-muted hover:text-nq-foreground",
                          blockOthers && "pointer-events-none opacity-45",
                        )}
                      >
                        {labels.cancelButton}
                      </button>
                      <button
                        type="button"
                        disabled={blockOthers}
                        onClick={() => onAssignClick(item.id)}
                        data-testid={`queue-assign-${item.id}`}
                        className={cn(
                          "min-h-10 flex-[1.15] rounded-lg bg-nq-primary px-3 text-sm font-semibold text-nq-navy-deep transition-opacity hover:opacity-95",
                          blockOthers && "pointer-events-none opacity-45",
                        )}
                      >
                        {labels.assignButton}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
