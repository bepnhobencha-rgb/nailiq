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

interface Props {
  /** Server-loaded initial data. Client-side refresh calls loadPartyCardsAction. */
  initialCards: PartyCard[];
  slug: string;
  currencyCode: Currency;
}

const MODE_LABEL: Record<string, string> = {
  sync_start: "Arrive together",
  sync_finish: "Finish together",
};

export function PartyCardPanel({ initialCards, slug, currencyCode }: Props) {
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
          {todayCount > 0
            ? `${todayCount} group booking${todayCount !== 1 ? "s" : ""} · next 7 days`
            : "No upcoming group bookings"}
        </span>

        {/* Refresh */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleRefresh();
          }}
          disabled={isPending}
          aria-label="Refresh party cards"
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
              No group bookings in the next 7 days.
            </p>
          ) : (
            <ul className="flex gap-3 pb-1" role="list">
              {cards.map((card) => (
                <li key={card.partyLinkId} className="w-72 shrink-0 sm:w-80">
                  <PartyCardItem
                    card={card}
                    currencyCode={currencyCode}
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
  copyState,
  onCopy,
}: {
  card: PartyCard;
  currencyCode: Currency;
  copyState: "idle" | "copied";
  onCopy: () => void;
}) {
  const [slotsOpen, setSlotsOpen] = useState(false);

  return (
    <div
      data-testid={`party-card-${card.groupId}`}
      className={cn(
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
            <StatusBadge status="expired" />
          ) : (
            <span className="rounded bg-nq-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-nq-primary">
              {MODE_LABEL[card.mode] ?? card.mode}
            </span>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="mt-2 px-3">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-nq-muted">
            {card.claimedCount}/{card.totalSlots} confirmed
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
        <span>{card.totalSlots} slot{card.totalSlots !== 1 ? "s" : ""}</span>
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
          {card.slots.map((slot, idx) => (
            <SlotRow key={slot.claimId} slot={slot} index={idx} />
          ))}
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
          {copyState === "copied" ? "✓ Copied!" : "Copy party link"}
        </button>
      </div>
    </div>
  );
}

// ─── Slot Row ─────────────────────────────────────────────────────

function SlotRow({ slot, index }: { slot: PartyCardSlot; index: number }) {
  return (
    <li
      data-testid={`party-slot-${slot.claimId}`}
      className="flex items-center gap-2 text-[11px]"
    >
      <StatusBadge status={slot.claimed ? "confirmed" : "pending"} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-nq-foreground">
          {slot.memberName ?? `Guest ${index + 1}`}
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

function StatusBadge({ status }: { status: "confirmed" | "pending" | "expired" }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold",
        status === "confirmed" && "bg-nq-success/15 text-nq-success",
        status === "pending"   && "bg-amber-400/15 text-amber-400",
        status === "expired"   && "bg-nq-muted/15 text-nq-muted",
      )}
    >
      {status === "confirmed" ? "Confirmed"
        : status === "pending" ? "Pending"
        : "Expired"}
    </span>
  );
}
