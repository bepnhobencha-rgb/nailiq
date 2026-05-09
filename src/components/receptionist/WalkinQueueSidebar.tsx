"use client";

import { useMemo, useState } from "react";

import { cn } from "@/shared/lib/cn";
import { isWalkinUrgent, minutesWaiting } from "@/shared/lib/queueUrgency";
import type {
  QueuePriority,
  QueueRequestTag,
  QueueSource,
} from "@/shared/types";

import { QueueEntryCard } from "./QueueEntryCard";
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
  walkin_source?: QueueSource | null;
  walkin_priority?: QueuePriority | null;
  walkin_request_tags?: ReadonlyArray<QueueRequestTag>;
  party_size?: number | null;
}

export type QueueSortMode = "fifo" | "longest_wait";

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
    sortLabel: string;
    sortFifo: string;
    sortLongestWait: string;
    priorityHigh: string;
    priorityMedium: string;
    priorityLow: string;
    partySizeLabel: (n: number) => string;
    sourceFallback: string;
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
  /**
   * Realtime offline gate — when true, the walk-in add form shows
   * an offline-specific hint and the submit button is locked to
   * prevent stale-data writes (mutation guard for the connection
   * banner state).
   */
  isOffline?: boolean;
  /** Localized "Offline — cannot add walk-ins" hint shown above submit. */
  offlineAddDisabledHint?: string;
  /** `quick_add` module — hides the walk-in intake form */
  showQuickAdd?: boolean;
  /** `wait_time` module — hides urgency styling and wait badges */
  showWaitTime?: boolean;
  /** `vip_indicators` module — hides VIP source chip */
  showVipIndicator?: boolean;
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
  isOffline = false,
  offlineAddDisabledHint,
  showQuickAdd = true,
  showWaitTime = true,
  showVipIndicator = true,
}: WalkinQueueSidebarProps) {
  const [sortMode, setSortMode] = useState<QueueSortMode>("fifo");

  const orderedItems = useMemo(() => {
    if (sortMode !== "longest_wait") return items;
    // Stable longest-wait-first: parse joinedAt once; older joinedAt → larger wait.
    return [...items].sort((a, b) => {
      const aTime = Date.parse(a.joined_queue_at);
      const bTime = Date.parse(b.joined_queue_at);
      const aOk = Number.isFinite(aTime);
      const bOk = Number.isFinite(bTime);
      if (!aOk && !bOk) return 0;
      if (!aOk) return 1;
      if (!bOk) return -1;
      return aTime - bTime;
    });
  }, [items, sortMode]);

  const onAssignClick = (itemId: string) => {
    if (assigningId !== null && assigningId !== itemId) {
      onCancelAssign();
      onStartAssign(itemId);
      return;
    }
    onStartAssign(itemId);
  };

  return (
    <aside
      data-testid="walkin-queue-sidebar"
      className="flex h-full min-h-0 flex-col bg-nq-surface"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-nq-muted/20 px-3 py-2">
        <h2 className="text-sm font-semibold text-nq-foreground">{labels.title}</h2>
        <span className="rounded-full bg-nq-primary/20 px-2.5 py-0.5 font-mono text-xs font-semibold tabular-nums text-nq-primary">
          {items.length}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3">
        {showQuickAdd ? (
          <WalkinAddForm
            services={services}
            labels={labels.addForm}
            onSubmit={onAddWalkin}
            disabled={addFormDisabled}
            isOffline={isOffline}
            offlineDisabledHint={offlineAddDisabledHint}
          />
        ) : null}

        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-nq-muted">
            <span className="text-lg text-nq-muted/80" aria-hidden>
              {showQuickAdd ? "↑" : "—"}
            </span>
            <p>{labels.emptyMessage}</p>
          </div>
        ) : (
          <>
            {items.length > 1 ? (
              <div className="mt-3 flex items-center justify-between gap-2 text-xs">
                <label
                  htmlFor="walkin-queue-sort"
                  className="text-nq-muted"
                >
                  {labels.sortLabel}
                </label>
                <select
                  id="walkin-queue-sort"
                  data-testid="walkin-queue-sort"
                  value={sortMode}
                  onChange={(e) =>
                    setSortMode(e.target.value as QueueSortMode)
                  }
                  className="h-8 rounded-md border border-nq-border bg-nq-bg px-2 text-xs text-nq-foreground focus:outline-none focus:ring-2 focus:ring-nq-primary/40"
                >
                  <option value="fifo">{labels.sortFifo}</option>
                  <option value="longest_wait">{labels.sortLongestWait}</option>
                </select>
              </div>
            ) : null}

            <ul className="mt-3 space-y-3 pb-4">
              {orderedItems.map((item, idx) => {
                const waited = minutesWaiting(item.joined_queue_at, nowIso);
                const urgentByLib =
                  showWaitTime &&
                  isWalkinUrgent({
                    joinedQueueAtIso: item.joined_queue_at,
                    staffRequestNote: item.staff_request_note,
                    nowIso,
                  });
                const assigningThis = assigningId === item.id;
                const blockOthers = assigningId !== null && !assigningThis;
                const tags: QueueRequestTag[] = [];
                if (item.walkin_request_tags) {
                  for (const t of item.walkin_request_tags) tags.push(t);
                }
                if (item.staff_request_note) {
                  tags.push(item.staff_request_note);
                }

                return (
                  <li
                    key={item.id}
                    className="relative"
                    data-testid={`queue-item-${item.id}`}
                  >
                    {assigningThis ? (
                      <p
                        data-testid="walkin-assign-active-hint"
                        className="mb-1 rounded-md border border-nq-primary/40 bg-nq-primary/10 px-2 py-1 text-center text-[11px] font-semibold uppercase tracking-wide text-nq-primary"
                      >
                        {labels.waitingHint}
                      </p>
                    ) : null}

                    <QueueEntryCard
                      position={idx + 1}
                      customerName={item.client_name}
                      serviceName={item.service_name}
                      waitMinutes={waited}
                      serviceDurationMinutes={item.service_duration_minutes}
                      source={item.walkin_source ?? null}
                      priority={item.walkin_priority ?? null}
                      requestTags={tags}
                      partySize={item.party_size ?? null}
                      showWaitTime={showWaitTime}
                      showVipIndicator={showVipIndicator}
                      isAssigning={assigningThis}
                      labels={{
                        minutesAgo: labels.minutesAgo,
                        priorityHigh: labels.priorityHigh,
                        priorityMedium: labels.priorityMedium,
                        priorityLow: labels.priorityLow,
                        partySizeLabel: labels.partySizeLabel,
                        sourceFallback: labels.sourceFallback,
                      }}
                      actions={
                        <div className="flex gap-2">
                          {urgentByLib && showWaitTime ? (
                            <span
                              aria-hidden
                              className="sr-only"
                              data-testid={`queue-urgent-${item.id}`}
                            >
                              ⚡ {labels.urgentBadge}
                            </span>
                          ) : null}
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
                      }
                    />
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}
