"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, X as CloseIcon } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { displayCustomerName } from "@/shared/lib/customerDisplayName";
import { isWalkinUrgent, minutesWaiting } from "@/shared/lib/queueUrgency";
import type {
  QueuePriority,
  QueueRequestTag,
  QueueSource,
} from "@/shared/types";

import { QueueEntryCard } from "./QueueEntryCard";
import { WalkinAddForm, type WalkinAddFormProps } from "./WalkinAddForm";
import { CustomerWaitLinkModal } from "./CustomerWaitLinkModal";

export interface QueueItem {
  id: string;
  client_name: string;
  client_phone: string | null;
  /** Service FK for ghost width / assignment span (caller supplies from loader row). */
  service_id: string;
  service_name: string;
  service_duration_minutes: number;
  staff_request_note: string | null;
  staff_requested_by_client?: boolean;
  /** Resolved staff name for the requested-staff row on the queue card. */
  requested_staff_name?: string | null;
  /** Projected UTC ISO time the requested staff is free. */
  requested_staff_ready_at_iso?: string | null;
  /** Returning-VIP flag (drives the gold crown badge). */
  is_vip?: boolean;
  /** Soft-hold expiry (UTC ISO). When set + > now the card renders a
   * countdown instead of the normal waiting treatment. */
  soft_hold_until?: string | null;
  joined_queue_at: string;
  walkin_source?: QueueSource | null;
  walkin_priority?: QueuePriority | null;
  walkin_request_tags?: ReadonlyArray<QueueRequestTag>;
  party_size?: number | null;
}

export type QueueSortMode = "fifo" | "longest_wait" | "custom";

export interface WalkinQueueSidebarProps {
  /** Optional close handler. When provided, the panel header renders a
   *  close (X) button — the slide-over no longer needs its own header,
   *  so the "Walk-in queue" title is shown exactly once. */
  onClose?: () => void;
  /** Accessible label for the close button. */
  closeLabel?: string;
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
    /** Display label for a redacted/removed customer ("[removed]" in DB). */
    removedGuest: string;
    emptyMessage: string;
    cancelButton: string;
    assignButton: string;
    urgentBadge: string;
    waitingHint: string;
    minutesAgo: (n: number) => string;
    sortLabel: string;
    sortFifo: string;
    sortLongestWait: string;
    sortCustom: string;
    avgWait: (n: number) => string;
    priorityHigh: string;
    priorityMedium: string;
    priorityLow: string;
    partySizeLabel: (n: number) => string;
    sourceFallback: string;
    /** "chờ" / "waiting" — shown under the hero wait number on each card. */
    waitHeroSuffix: string;
    vipAria: string;
    /** "Ready ~{time}" template for the staff-dispatch line. */
    readyAroundShort: string;
    requestedByClientLine: string;
    /** "⚠️ {name} — {n} đang chờ. Cân nhắc thợ khác." overload banner. */
    overloadBanner: (input: { name: string; queueAhead: number }) => string;
    overloadBannerDismiss: string;
    /** Soft-hold copy (PR #104). */
    softHoldButton: string;
    softHoldClear: string;
    softHoldLabel: string;
    softHoldCountdown: (minutesLeft: number) => string;
    /** Customer wait-link share (PR #105). */
    waitLinkButton: string;
    waitLinkModal: {
      title: string;
      instruction: string;
      copyLink: string;
      copied: string;
      openLink: string;
      closeAria: string;
    };
  };
  /** Callbacks */
  onAddWalkin: WalkinAddFormProps["onSubmit"];
  /** Direct-assign path — bypasses the queue when staff is free now. */
  onAddAndAssign?: WalkinAddFormProps["onAddAndAssign"];
  /** Salon-level "auto-assign available staff" flag. False forces
   * every walk-in into the queue. */
  autoAssignEnabled?: boolean;
  /** Phone lookup hook — server action for client_profile + per-salon stats. */
  onPhoneLookup?: WalkinAddFormProps["onPhoneLookup"];
  /** Smart-availability hook — server-side staff availability lookup. */
  onCheckAvailability?: WalkinAddFormProps["onCheckAvailability"];
  /** Active staff for the "Requested staff" dropdown. */
  staffOptions?: WalkinAddFormProps["staffOptions"];
  /**
   * Overload signals — names of staff currently flagged
   * `overloaded=true` by the availability engine plus their
   * pending-customer count. Drives the dismissible warning banner
   * above the queue list. Optional — when omitted no banner renders.
   */
  overloadedStaff?: ReadonlyArray<{ name: string; queueAhead: number }>;
  /** Soft-hold callbacks. Optional — when omitted the per-card hold
   * action is hidden (keeps the form usable in storybook / tests). */
  onSetSoftHold?: (
    bookingId: string,
    minutes: number,
  ) => Promise<{ ok: boolean; holdUntilIso?: string; error?: string }>;
  onClearSoftHold?: (
    bookingId: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** True when the desk is in rush hour. Cards enlarge the wait
   * number and the form header gets a subtle peripheral fade upstream. */
  rushMode?: boolean;
  /** Whether the desk may create a customer wait link. */
  waitLinkEnabled?: boolean;
  /** Salon slug — only used when wait links are enabled. */
  waitLinkSalonSlug?: string;
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
  /** Bumped by the parent on an explicit "+ Walk-in" open → focuses the name field. */
  focusAddNonce?: number;
  /** `wait_time` module — hides urgency styling and wait badges */
  showWaitTime?: boolean;
  /** `vip_indicators` module — hides VIP source chip */
  showVipIndicator?: boolean;
  /** Compact mode (density=simple): each card shows only position + name + service. */
  compact?: boolean;
  /** Salon-level queue display mode (salons.queue_display_mode). */
  queueDisplayMode?: "simple" | "full";
  /**
   * Popular service ids derived from today's bookings (server-side, in
   * `loadReceptionistCenterData`). Rendered as shortcut chips above the
   * service grid in `WalkinAddForm`. Empty array hides the chip row.
   */
  popularServiceIds?: ReadonlyArray<string>;
  /** Localized label for the popular services chip row ("Popular today"). */
  popularServicesLabel?: string;
  /** P0.2 — salon's configured currency (drives service-tile + VIP-card prices). */
  currency: import("@/shared/lib/currencyFormat").Currency;
}

function SortableQueueItem({
  id,
  isDragging,
  children,
}: {
  id: string;
  isDragging: boolean;
  children: (handle: React.ReactNode) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const handle = (
    <button
      type="button"
      {...attributes}
      {...listeners}
      aria-label="Drag to reorder"
      className="absolute left-1 top-1/2 -translate-y-1/2 cursor-grab touch-none p-1 text-nq-muted/40 hover:text-nq-muted active:cursor-grabbing"
    >
      <GripVertical size={14} />
    </button>
  );
  return (
    <li ref={setNodeRef} style={style} className="relative pl-5">
      {children(handle)}
    </li>
  );
}

export function WalkinQueueSidebar({
  onClose,
  closeLabel,
  items,
  assigningId,
  services,
  labels,
  onAddWalkin,
  onAddAndAssign,
  autoAssignEnabled = true,
  onPhoneLookup,
  onCheckAvailability,
  staffOptions,
  overloadedStaff,
  onSetSoftHold,
  onClearSoftHold,
  rushMode = false,
  waitLinkEnabled = false,
  waitLinkSalonSlug,
  onCancelWalkin,
  onStartAssign,
  onCancelAssign,
  nowIso,
  addFormDisabled = false,
  isOffline = false,
  offlineAddDisabledHint,
  showQuickAdd = true,
  focusAddNonce,
  showWaitTime = true,
  showVipIndicator = true,
  compact = false,
  queueDisplayMode = "full",
  popularServiceIds,
  popularServicesLabel,
  currency,
}: WalkinQueueSidebarProps) {
  const [sortMode, setSortMode] = useState<QueueSortMode>("fifo");
  // Per-card wait-link modal — null when closed; otherwise the
  // bookingId whose modal is currently open.
  const [waitLinkOpenForId, setWaitLinkOpenForId] = useState<string | null>(
    null,
  );
  // Per-session dismissals — receptionist can suppress a specific
  // staff's overload warning until the page is reloaded. We key by
  // name (only field surfaced today) so the dismissed set survives
  // the staff still being in the overloaded list.
  const [dismissedOverloads, setDismissedOverloads] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const visibleOverloads = useMemo(() => {
    return (overloadedStaff ?? []).filter(
      (o) => !dismissedOverloads.has(o.name),
    );
  }, [overloadedStaff, dismissedOverloads]);

  // Custom drag order — null means "use server order". When set,
  // stores the IDs in the receptionist's preferred sequence.
  const [customOrder, setCustomOrder] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const prevItemIds = useRef<string>("");

  // Merge server updates into customOrder: add new arrivals at the
  // end, drop IDs that are no longer in the queue.
  useEffect(() => {
    const incomingIds = items.map((i) => i.id).join(",");
    if (incomingIds === prevItemIds.current) return;
    prevItemIds.current = incomingIds;
    setCustomOrder((prev) => {
      if (!prev) return null;
      const incoming = new Set(items.map((i) => i.id));
      const filtered = prev.filter((id) => incoming.has(id));
      const added = items.filter((i) => !prev.includes(i.id)).map((i) => i.id);
      return [...filtered, ...added];
    });
  }, [items]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  );

  const orderedItems = useMemo(() => {
    if (sortMode === "custom" && customOrder) {
      const map = new Map(items.map((i) => [i.id, i]));
      return customOrder.flatMap((id) => {
        const item = map.get(id);
        return item ? [item] : [];
      });
    }
    if (sortMode === "longest_wait") {
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
    }
    return items;
  }, [items, sortMode, customOrder]);

  const avgWaitMinutes = useMemo(() => {
    if (items.length === 0) return null;
    const total = items.reduce(
      (sum, item) => sum + minutesWaiting(item.joined_queue_at, nowIso),
      0,
    );
    return Math.round(total / items.length);
  }, [items, nowIso]);

  function handleDragEnd(event: DragEndEvent) {
    setDraggingId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = orderedItems.map((i) => i.id);
    const oldIdx = ids.indexOf(String(active.id));
    const newIdx = ids.indexOf(String(over.id));
    if (oldIdx === -1 || newIdx === -1) return;
    setCustomOrder(arrayMove(ids, oldIdx, newIdx));
    setSortMode("custom");
  }

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
      // `id="queue"` is the scroll target for the sidebar
      // Walk-in Queue tab's `#queue` deep-link.
      id="queue"
      data-testid="walkin-queue-sidebar"
      data-walkin-queue-panel="true"
      className="flex h-full min-h-0 flex-col bg-nq-surface"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-nq-muted/20 px-3 py-2">
        <h2 className="text-base font-semibold text-nq-foreground">{labels.title}</h2>
        <div className="flex items-center gap-2">
          {showWaitTime && avgWaitMinutes !== null ? (
            <span className="text-base text-nq-muted tabular-nums">
              {labels.avgWait(avgWaitMinutes)}
            </span>
          ) : null}
          <span className="rounded-full bg-nq-primary/20 px-2.5 py-1 font-mono text-base font-semibold tabular-nums text-nq-primary">
            {items.length}
          </span>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={closeLabel ?? "Close"}
              className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md border border-nq-border/40 bg-nq-surface/40 text-base text-nq-muted transition-colors hover:bg-nq-surface/80 hover:text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45"
            >
              <CloseIcon className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3">
        {showQuickAdd ? (
          <WalkinAddForm
            services={services}
            currency={currency}
            labels={labels.addForm}
            onSubmit={onAddWalkin}
            onAddAndAssign={onAddAndAssign}
            autoAssignEnabled={autoAssignEnabled}
            focusNonce={focusAddNonce}
            onPhoneLookup={onPhoneLookup}
            onCheckAvailability={onCheckAvailability}
            staffOptions={staffOptions}
            disabled={addFormDisabled}
            isOffline={isOffline}
            offlineDisabledHint={offlineAddDisabledHint}
            popularServiceIds={popularServiceIds}
            popularServicesLabel={popularServicesLabel}
          />
        ) : null}

        {visibleOverloads.length > 0 ? (
          <div
            data-testid="walkin-queue-overload-banners"
            className="mt-3 space-y-1.5"
          >
            {visibleOverloads.map((o) => (
              <div
                key={o.name}
                role="status"
                data-testid={`walkin-queue-overload-${o.name}`}
                className="flex items-start justify-between gap-2 rounded-md border border-amber-500/55 bg-amber-400/10 px-2.5 py-2 text-[11px] text-nq-foreground"
              >
                <p>
                  {labels.overloadBanner({
                    name: o.name,
                    queueAhead: o.queueAhead,
                  })}
                </p>
                <button
                  type="button"
                  aria-label={labels.overloadBannerDismiss}
                  title={labels.overloadBannerDismiss}
                  onClick={() =>
                    setDismissedOverloads((prev) => {
                      const next = new Set(prev);
                      next.add(o.name);
                      return next;
                    })
                  }
                  className="shrink-0 text-nq-muted hover:text-nq-foreground"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
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
                  onChange={(e) => {
                    const next = e.target.value as QueueSortMode;
                    setSortMode(next);
                    if (next !== "custom") setCustomOrder(null);
                  }}
                  className="h-8 rounded-md border border-nq-border bg-nq-bg px-2 text-xs text-nq-foreground focus:outline-none focus:ring-2 focus:ring-nq-primary/40"
                >
                  <option value="fifo">{labels.sortFifo}</option>
                  <option value="longest_wait">{labels.sortLongestWait}</option>
                  {sortMode === "custom" ? (
                    <option value="custom">{labels.sortCustom}</option>
                  ) : null}
                </select>
              </div>
            ) : null}

            <DndContext
              // Stable id → dnd-kit's a11y announcer renders a deterministic
              // `aria-describedby` ("DndDescribedBy-<id>") instead of an
              // auto-incrementing counter that differs between SSR and client
              // and triggers a React hydration attribute mismatch.
              id="walkin-queue-dnd"
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={(e) => setDraggingId(String(e.active.id))}
              onDragCancel={() => setDraggingId(null)}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={orderedItems.map((i) => i.id)}
                strategy={verticalListSortingStrategy}
              >
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
                      <SortableQueueItem
                        key={item.id}
                        id={item.id}
                        isDragging={draggingId === item.id}
                      >
                        {(handle) => (
                          <div data-testid={`queue-item-${item.id}`}>
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
                      customerName={displayCustomerName(item.client_name, labels.removedGuest)}
                      serviceName={item.service_name}
                      waitMinutes={waited}
                      serviceDurationMinutes={item.service_duration_minutes}
                      source={item.walkin_source ?? null}
                      priority={item.walkin_priority ?? null}
                      requestTags={tags}
                      partySize={item.party_size ?? null}
                      isVip={item.is_vip ?? false}
                      staffRequestedByClient={
                        item.staff_requested_by_client ?? false
                      }
                      requestedStaffName={item.requested_staff_name ?? null}
                      requestedStaffReadyAtIso={
                        item.requested_staff_ready_at_iso ?? null
                      }
                      showWaitTime={showWaitTime}
                      showVipIndicator={showVipIndicator}
                      emphasizeWait={rushMode}
                      softHoldUntilIso={item.soft_hold_until ?? null}
                      nowIso={nowIso}
                      isAssigning={assigningThis}
                      compact={compact}
                      displayMode={queueDisplayMode}
                      labels={{
                        waitHeroSuffix: labels.waitHeroSuffix,
                        vipAria: labels.vipAria,
                        readyAroundShort: labels.readyAroundShort,
                        requestedByClientLine: labels.requestedByClientLine,
                        priorityHigh: labels.priorityHigh,
                        priorityMedium: labels.priorityMedium,
                        priorityLow: labels.priorityLow,
                        partySizeLabel: labels.partySizeLabel,
                        sourceFallback: labels.sourceFallback,
                        softHoldCountdown: labels.softHoldCountdown,
                        softHoldLabel: labels.softHoldLabel,
                      }}
                      actions={
                        <div className="space-y-2">
                          {urgentByLib && showWaitTime ? (
                            <span
                              aria-hidden
                              className="sr-only"
                              data-testid={`queue-urgent-${item.id}`}
                            >
                              ⚡ {labels.urgentBadge}
                            </span>
                          ) : null}
                          <div className="flex gap-2">
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
                          {onSetSoftHold || onClearSoftHold ? (() => {
                            const isHeld = !!item.soft_hold_until &&
                              Date.parse(item.soft_hold_until) > Date.parse(nowIso);
                            if (isHeld && onClearSoftHold) {
                              return (
                                <button
                                  type="button"
                                  disabled={blockOthers}
                                  onClick={() => void onClearSoftHold(item.id)}
                                  data-testid={`queue-clear-hold-${item.id}`}
                                  className={cn(
                                    "min-h-9 w-full rounded-lg border border-amber-500/55 bg-transparent px-3 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-400/15",
                                    blockOthers && "pointer-events-none opacity-45",
                                  )}
                                >
                                  {labels.softHoldClear}
                                </button>
                              );
                            }
                            if (!isHeld && onSetSoftHold) {
                              return (
                                <button
                                  type="button"
                                  disabled={blockOthers}
                                  onClick={() =>
                                    void onSetSoftHold(item.id, 10)
                                  }
                                  data-testid={`queue-soft-hold-${item.id}`}
                                  className={cn(
                                    "min-h-9 w-full rounded-lg border border-nq-muted/35 bg-transparent px-3 text-xs font-medium text-nq-muted transition-colors hover:border-nq-muted hover:text-nq-foreground",
                                    blockOthers && "pointer-events-none opacity-45",
                                  )}
                                >
                                  {labels.softHoldButton}
                                </button>
                              );
                            }
                            return null;
                          })() : null}
                          {waitLinkEnabled ? (
                            <button
                              type="button"
                              disabled={blockOthers}
                              onClick={() =>
                                setWaitLinkOpenForId(item.id)
                              }
                              data-testid={`queue-wait-link-${item.id}`}
                              className={cn(
                                "min-h-9 w-full rounded-lg border border-nq-muted/35 bg-transparent px-3 text-xs font-medium text-nq-muted transition-colors hover:border-nq-muted hover:text-nq-foreground",
                                blockOthers && "pointer-events-none opacity-45",
                              )}
                            >
                              📱 {labels.waitLinkButton}
                            </button>
                          ) : null}
                        </div>
                      }
                      dragHandle={handle}
                    />
                          </div>
                        )}
                      </SortableQueueItem>
                    );
                  })}
                </ul>
              </SortableContext>
            </DndContext>
          </>
        )}
      </div>

      {waitLinkOpenForId && waitLinkSalonSlug ? (() => {
        const target = items.find((i) => i.id === waitLinkOpenForId);
        if (!target) return null;
        // The modal is reachable only from a post-hydration click, so reading
        // the browser origin here never participates in SSR/hydration.
        const url = `${window.location.origin}/${encodeURIComponent(
          waitLinkSalonSlug,
        )}/wait/${target.id}`;
        return (
          <CustomerWaitLinkModal
            open
            url={url}
            customerName={displayCustomerName(target.client_name, labels.removedGuest)}
            onClose={() => setWaitLinkOpenForId(null)}
            labels={labels.waitLinkModal}
          />
        );
      })() : null}
    </aside>
  );
}
