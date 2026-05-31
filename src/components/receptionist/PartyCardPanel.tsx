"use client";

/**
 * PartyCardPanel — Receptionist-facing view of upcoming group bookings.
 *
 * Renders a collapsible horizontal strip between the receptionist header
 * and the three-zone timeline grid. Each Party Card shows a group booking's
 * date, mode, slot list (confirmed / pending), progress, estimated revenue,
 * and a Copy Link button.
 *
 * Security:
 *   - Member phone numbers are NEVER rendered (not in PartyCard type).
 *   - Estimated revenue is only shown when estimatedRevenueCents is non-null
 *     (set by the loader only when all slots have reliable price data).
 *   - Cards are scoped to the caller's salon by the server action.
 */

import { useState, useTransition } from "react";
import { loadPartyCardsAction, type PartyCard, type PartyCardSlot } from "@/shared/dashboard/loadPartyCardsAction";
import type { Currency } from "@/shared/lib/currencyFormat";
import { formatCurrency } from "@/shared/lib/currencyFormat";
import { cn } from "@/shared/lib/cn";
import type { getUserMessages } from "@/shared/i18n/user";

/** Localized strings for the party-card strip (EN/VI). */
export type PartyCardLabels =
  ReturnType<typeof getUserMessages>["receptionist"]["partyCard"];

interface Props {
  /** Server-loaded initial data. Client-side refresh calls loadPartyCardsAction. */
  initialCards: PartyCard[];
  slug: string;
  currencyCode: Currency;
  labels: PartyCardLabels;
}

export function PartyCardPanel({ initialCards, slug, currencyCode, labels }: Props) {
  const [cards, setCards] = useState<PartyCard[]>(initialCards);
  const [open, setOpen] = useState(initialCards.length > 0);
  const [isPending, startTransition] = useTransition();
  const [copyStates, setCopyStates] = useState<Record<string, "idle" | "copied">>({});

  const todayCount = cards.filter((c) => !c.expired).length;

  function handleRefresh() {
    startTransition(async () => {
      const result = await loadPartyCardsAction(slug);
      if (result.ok) setCards(result.cards);
    });
  }

  function handleCopy(token: string, url: string) {
    navigator.clipboard.writeText(url).then(() => {
      setCopyStates((prev) => ({ ...prev, [token]: "copied" }));
      setTimeout(
        () => setCopyStates((prev) => ({ ...prev, [token]: "idle" })),
        2000,
      );
    });
  }

  return (
    <section
      data-testid="party-card-panel"
      className="shrink-0 border-b border-nq-border/40 bg-nq-bg"
      aria-label="Group party bookings"
    >
      {/* ── Collapse toggle ──────────────────────────────────────── */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 px-[var(--pad-nq-section-mobile)] py-2 md:px-6",
          "text-left text-xs font-medium transition-colors",
          "hover:bg-nq-surface/60",
          open ? "text-nq-primary" : "text-nq-muted",
        )}
        aria-expanded={open}
        data-testid="party-card-panel-toggle"
      >
        <span className="text-sm" aria-hidden>👥</span>
        <span className="flex-1">
          {todayCount > 0 ? labels.panelSummary(todayCount) : labels.panelEmpty}
        </span>

        {/* Refresh */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleRefresh();
          }}
          disabled={isPending}
          aria-label={labels.refresh}
          className={cn(
            "rounded p-0.5 text-nq-muted hover:text-nq-foreground transition-colors",
            isPending && "animate-pulse",
          )}
        >
          ↺
        </button>

        {/* Chevron */}
        <span
          className={cn(
            "text-nq-muted transition-transform duration-[var(--duration-nq-base)]",
            open && "rotate-180",
          )}
          aria-hidden
        >
          ▾
        </span>
      </button>

      {/* ── Card list ────────────────────────────────────────────── */}
      {open && (
        <div
          className={cn(
            "mx-auto w-full max-w-[var(--max-nq-desktop)]",
            "overflow-x-auto px-[var(--pad-nq-section-mobile)] pb-3 md:px-6",
          )}
        >
          {cards.length === 0 ? (
            <p className="py-4 text-center text-xs text-nq-muted">
              {labels.emptyNext7}
            </p>
          ) : (
            <ul className="flex gap-3 pb-1" role="list">
              {cards.map((card) => (
                <li key={card.partyLinkId} className="w-72 shrink-0 sm:w-80">
                  <PartyCardItem
                    card={card}
                    currencyCode={currencyCode}
                    labels={labels}
                    copyState={copyStates[card.token] ?? "idle"}
                    onCopy={() => {
                      const url =
                        typeof window !== "undefined"
                          ? `${window.location.origin}/party/${card.token}`
                          : `/party/${card.token}`;
                      handleCopy(card.token, url);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Individual Party Card ────────────────────────────────────────

function PartyCardItem({
  card,
  currencyCode,
  labels,
  copyState,
  onCopy,
}: {
  card: PartyCard;
  currencyCode: Currency;
  labels: PartyCardLabels;
  copyState: "idle" | "copied";
  onCopy: () => void;
}) {
  const [slotsOpen, setSlotsOpen] = useState(false);

  return (
    <div
      id={`party-card-${card.groupId}`}
      data-testid={`party-card-${card.groupId}`}
      className={cn(
        "scroll-mt-4",
        "rounded-xl border bg-nq-surface text-nq-foreground",
        card.expired
          ? "border-nq-muted/20 opacity-60"
          : "border-nq-border/50 shadow-[var(--shadow-nq-sm)]",
      )}
    >
      {/* Card header */}
      <div className="flex items-start justify-between gap-2 px-3 pt-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-nq-foreground">
            {card.groupDateDisplay}
          </p>
          <p className="text-[11px] text-nq-muted">
            {card.groupStartDisplay} – {card.groupEndDisplay}
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          {card.expired ? (
            <StatusBadge status="expired" labels={labels} />
          ) : (
            <span className="rounded bg-nq-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-nq-primary">
              {card.mode === "sync_finish"
                ? labels.finishTogether
                : labels.arriveTogether}
            </span>
          )}
          {card.pendingChangeRequestCount > 0 && (
            <span
              data-testid={`party-card-change-requests-${card.groupId}`}
              className="rounded bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600"
            >
              {labels.changesRequested(card.pendingChangeRequestCount)}
            </span>
          )}
          {card.waveCount > 1 && (
            <span
              data-testid={`party-card-waves-${card.groupId}`}
              className="rounded bg-nq-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-nq-primary"
            >
              {labels.wavesBadge(card.waveCount)}
            </span>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="mt-2 px-3">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-nq-muted">
            {labels.confirmedProgress(card.claimedCount, card.totalSlots)}
            {card.pendingCount > 0 && (
              <span
                data-testid={`party-card-pending-${card.groupId}`}
                className="text-amber-400"
                title={labels.pendingHelp}
              >
                {" · "}{labels.pendingSuffix(card.pendingCount)}
              </span>
            )}
          </span>
          {card.estimatedRevenueCents != null && (
            <span
              data-testid={`party-card-revenue-${card.groupId}`}
              className="text-nq-primary"
            >
              {formatCurrency(card.estimatedRevenueCents, currencyCode)}
            </span>
          )}
        </div>
        <ProgressBar value={card.claimedCount} max={card.totalSlots} />
      </div>

      {/* Slot list toggle */}
      <button
        type="button"
        onClick={() => setSlotsOpen((v) => !v)}
        className="mt-2 flex w-full items-center justify-between px-3 py-1.5 text-[11px] text-nq-muted hover:text-nq-foreground transition-colors"
        aria-expanded={slotsOpen}
      >
        <span>{labels.slotsCount(card.totalSlots)}</span>
        <span
          className={cn(
            "transition-transform duration-[var(--duration-nq-base)]",
            slotsOpen && "rotate-180",
          )}
        >
          ▾
        </span>
      </button>

      {/* Slot rows */}
      {slotsOpen && (
        <ul className="border-t border-nq-border/30 px-3 py-2 space-y-1.5" role="list">
          {card.waveCount > 1
            ? [...new Set(card.slots.map((s) => s.waveNumber))]
                .sort((a, b) => a - b)
                .flatMap((wn) => [
                  <li
                    key={`wave-${wn}`}
                    data-testid={`party-card-wave-${card.groupId}-${wn}`}
                    className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-nq-muted"
                  >
                    {labels.waveLabel(wn)}
                  </li>,
                  ...card.slots
                    .filter((s) => s.waveNumber === wn)
                    .map((slot) => <SlotRow key={slot.claimId} slot={slot} labels={labels} />),
                ])
            : card.slots.map((slot) => <SlotRow key={slot.claimId} slot={slot} labels={labels} />)}
        </ul>
      )}

      {/* Footer: Copy link */}
      <div className="border-t border-nq-border/30 px-3 py-2">
        <button
          type="button"
          onClick={onCopy}
          data-testid={`party-card-copy-${card.groupId}`}
          className={cn(
            "w-full rounded-md py-1.5 text-[11px] font-semibold transition-colors",
            copyState === "copied"
              ? "bg-nq-success/20 text-nq-success"
              : "bg-nq-surface border border-nq-border/50 text-nq-muted hover:text-nq-foreground hover:border-nq-border",
          )}
        >
          {copyState === "copied" ? labels.copied : labels.copyLink}
        </button>
      </div>
    </div>
  );
}

// ─── Slot Row ─────────────────────────────────────────────────────

function SlotRow({ slot, labels }: { slot: PartyCardSlot; labels: PartyCardLabels }) {
  return (
    <li
      data-testid={`party-slot-${slot.claimId}`}
      className="flex items-center gap-2 text-[11px]"
    >
      <StatusBadge status={slot.claimed ? "confirmed" : "pending"} labels={labels} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-nq-foreground">
          {slot.memberName ?? slot.guestLabel}
        </p>
        <p className="truncate text-nq-muted">
          {slot.serviceName} · {slot.staffName}
        </p>
        <p className="text-nq-muted/70">
          {slot.startDisplay} – {slot.endDisplay}
        </p>
      </div>
    </li>
  );
}

// ─── Progress Bar ────────────────────────────────────────────────

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-nq-muted/20">
      <div
        className="h-full rounded-full bg-nq-success transition-all duration-[var(--duration-nq-slow)]"
        style={{ width: `${pct}%` }}
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={`${value} of ${max} confirmed`}
      />
    </div>
  );
}

// ─── Status Badge ────────────────────────────────────────────────

function StatusBadge({
  status,
  labels,
}: {
  status: "confirmed" | "pending" | "expired";
  labels: PartyCardLabels;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold",
        status === "confirmed" && "bg-nq-success/15 text-nq-success",
        status === "pending"   && "bg-amber-400/15 text-amber-400",
        status === "expired"   && "bg-nq-muted/15 text-nq-muted",
      )}
    >
      {status === "confirmed" ? labels.statusConfirmed
        : status === "pending" ? labels.statusPending
        : labels.statusExpired}
    </span>
  );
}
