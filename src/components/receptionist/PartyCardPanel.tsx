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
import { cancelDeskGroup } from "@/shared/dashboard/receptionistActions";
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
  salonId: string;
  currencyCode: Currency;
  labels: PartyCardLabels;
  /** Owner/senior only — gates the "Cancel party" action (server re-checks). */
  canCancel: boolean;
  /** Receptionist quick-claim: called when staff fills in a guest name on behalf. */
  onDeskClaim?: (claimId: string, token: string, memberName: string, memberPhone?: string) => Promise<{ ok: boolean }>;
}

/** Per-card lifecycle for the cancel-whole-group flow. */
type CancelState = "idle" | "confirm" | "cancelling" | "error";

export function PartyCardPanel({ initialCards, slug, salonId, currencyCode, labels, canCancel, onDeskClaim }: Props) {
  const [cards, setCards] = useState<PartyCard[]>(initialCards);
  const [open, setOpen] = useState(initialCards.length > 0);
  const [isPending, startTransition] = useTransition();
  const [, startCancelTransition] = useTransition();
  const [copyStates, setCopyStates] = useState<Record<string, "idle" | "copied">>({});
  const [cancelStates, setCancelStates] = useState<Record<string, CancelState>>({});

  const todayCount = cards.filter((c) => !c.expired).length;

  function handleRefresh() {
    startTransition(async () => {
      const result = await loadPartyCardsAction(slug);
      if (result.ok) setCards(result.cards);
    });
  }

  function setCancelState(groupId: string, state: CancelState) {
    setCancelStates((prev) => ({ ...prev, [groupId]: state }));
  }

  function handleCancelGroup(card: PartyCard, notify: { sms: boolean; email: boolean }) {
    setCancelState(card.groupId, "cancelling");
    startCancelTransition(async () => {
      const result = await cancelDeskGroup(slug, { salonId, groupId: card.groupId, notify });
      if (result.ok) {
        // Refresh from the server so the cancelled party drops off the strip.
        const refreshed = await loadPartyCardsAction(slug);
        if (refreshed.ok) setCards(refreshed.cards);
        setCancelState(card.groupId, "idle");
      } else {
        setCancelState(card.groupId, "error");
      }
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
      {/* ── Header row ────────────────────────────────────────────
          A flex row (NOT a button) so the Refresh control is a SIBLING of
          the collapse toggle, never nested inside it. Nesting a <button>
          in a <button> is invalid HTML — the browser un-nests it on the
          client, diverging from the SSR markup and throwing React #418
          hydration mismatch on every load. */}
      <div
        className={cn(
          "flex w-full items-center gap-2 px-[var(--pad-nq-section-mobile)] py-2 md:px-6",
          "text-xs font-medium",
        )}
      >
        {/* Collapse toggle — icon + summary + chevron */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex flex-1 items-center gap-2 text-left transition-colors",
            "hover:text-nq-foreground",
            open ? "text-nq-primary" : "text-nq-muted",
          )}
          aria-expanded={open}
          data-testid="party-card-panel-toggle"
        >
          <span className="text-sm" aria-hidden>👥</span>
          <span className="flex-1">
            {todayCount > 0 ? labels.panelSummary(todayCount) : labels.panelEmpty}
          </span>
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

        {/* Refresh — sibling of the toggle, not a descendant */}
        <button
          type="button"
          onClick={handleRefresh}
          disabled={isPending}
          aria-label={labels.refresh}
          data-testid="party-card-panel-refresh"
          className={cn(
            "shrink-0 rounded p-0.5 text-nq-muted hover:text-nq-foreground transition-colors",
            isPending && "animate-pulse",
          )}
        >
          ↺
        </button>
      </div>

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
                    canCancel={canCancel && !card.expired}
                    cancelState={cancelStates[card.groupId] ?? "idle"}
                    onCancelClick={() => setCancelState(card.groupId, "confirm")}
                    onCancelDismiss={() => setCancelState(card.groupId, "idle")}
                    onCancelConfirm={(notify) => handleCancelGroup(card, notify)}
                    onDeskClaim={onDeskClaim ? (claimId, name, phone) =>
                      onDeskClaim(claimId, card.token, name, phone).then((res) => {
                        if (res.ok) void handleRefresh();
                        return res;
                      }) : undefined}
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
  canCancel,
  cancelState,
  onCancelClick,
  onCancelDismiss,
  onCancelConfirm,
  onDeskClaim,
}: {
  card: PartyCard;
  currencyCode: Currency;
  labels: PartyCardLabels;
  copyState: "idle" | "copied";
  onCopy: () => void;
  canCancel: boolean;
  cancelState: CancelState;
  onCancelClick: () => void;
  onCancelDismiss: () => void;
  onCancelConfirm: (notify: { sms: boolean; email: boolean }) => void;
  onDeskClaim?: (claimId: string, memberName: string, memberPhone?: string) => Promise<{ ok: boolean }>;
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
          <p className="truncate text-[10px] text-nq-muted">
            {card.groupDateDisplay}
          </p>
          {card.organizerName ? (
            <p className="truncate text-sm font-semibold text-nq-foreground leading-tight">
              {card.organizerName}
            </p>
          ) : null}
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
                    .map((slot) => <SlotRow key={slot.claimId} slot={slot} labels={labels} onDeskClaim={onDeskClaim} />),
                ])
            : card.slots.map((slot) => <SlotRow key={slot.claimId} slot={slot} labels={labels} onDeskClaim={onDeskClaim} />)}
        </ul>
      )}

      {/* Footer: Copy link + (owner/senior) Cancel party */}
      <div className="space-y-2 border-t border-nq-border/30 px-3 py-2">
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

        {canCancel && (
          <PartyCancelControl
            card={card}
            labels={labels}
            cancelState={cancelState}
            onCancelClick={onCancelClick}
            onCancelDismiss={onCancelDismiss}
            onCancelConfirm={onCancelConfirm}
          />
        )}
      </div>
    </div>
  );
}

// ─── Cancel-whole-group control (owner/senior) ───────────────────
// Two-step inline confirm so a stray tap never wipes a party: idle → confirm
// → cancelling. The server action re-checks the role + status guards.
function PartyCancelControl({
  card,
  labels,
  cancelState,
  onCancelClick,
  onCancelDismiss,
  onCancelConfirm,
}: {
  card: PartyCard;
  labels: PartyCardLabels;
  cancelState: CancelState;
  onCancelClick: () => void;
  onCancelDismiss: () => void;
  onCancelConfirm: (notify: { sms: boolean; email: boolean }) => void;
}) {
  // Notify-the-organizer intent, captured alongside the cancel confirm. Both
  // default ON (the common case — let the party know it's off). The server only
  // sends on channels the organizer actually has contact for.
  const [notifySms, setNotifySms] = useState(true);
  const [notifyEmail, setNotifyEmail] = useState(true);

  if (cancelState === "confirm" || cancelState === "cancelling" || cancelState === "error") {
    const busy = cancelState === "cancelling";
    return (
      <div
        data-testid={`party-card-cancel-confirm-${card.groupId}`}
        className="rounded-md border border-nq-error/40 bg-nq-error/5 px-2.5 py-2"
      >
        <p className="text-[11px] font-medium text-nq-foreground">
          {labels.cancelConfirm(card.totalSlots)}
        </p>
        {/* Notify-the-organizer toggles */}
        <div className="mt-2 flex items-center gap-3 text-[11px] text-nq-muted">
          <span>{labels.notifyLabel}</span>
          <label className="flex cursor-pointer items-center gap-1">
            <input
              type="checkbox"
              checked={notifySms}
              disabled={busy}
              onChange={(e) => setNotifySms(e.target.checked)}
              data-testid={`party-card-notify-sms-${card.groupId}`}
              className="h-3.5 w-3.5 accent-nq-primary"
            />
            {labels.notifySms}
          </label>
          <label className="flex cursor-pointer items-center gap-1">
            <input
              type="checkbox"
              checked={notifyEmail}
              disabled={busy}
              onChange={(e) => setNotifyEmail(e.target.checked)}
              data-testid={`party-card-notify-email-${card.groupId}`}
              className="h-3.5 w-3.5 accent-nq-primary"
            />
            {labels.notifyEmail}
          </label>
        </div>
        {cancelState === "error" && (
          <p className="mt-1 text-[10px] text-nq-error">{labels.cancelError}</p>
        )}
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onCancelConfirm({ sms: notifySms, email: notifyEmail })}
            data-testid={`party-card-cancel-yes-${card.groupId}`}
            className={cn(
              "flex-1 rounded-md py-1.5 text-[11px] font-semibold transition-colors",
              "bg-nq-error/15 text-nq-error hover:bg-nq-error/25",
              busy && "opacity-60",
            )}
          >
            {busy ? labels.cancelling : labels.cancelConfirmYes}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onCancelDismiss}
            className="flex-1 rounded-md border border-nq-border/50 py-1.5 text-[11px] font-semibold text-nq-muted hover:text-nq-foreground transition-colors"
          >
            {labels.cancelConfirmNo}
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onCancelClick}
      data-testid={`party-card-cancel-${card.groupId}`}
      className="w-full rounded-md py-1.5 text-[11px] font-semibold text-nq-error/80 hover:bg-nq-error/10 hover:text-nq-error transition-colors"
    >
      {labels.cancelParty}
    </button>
  );
}

// ─── Slot Row ─────────────────────────────────────────────────────

function SlotRow({
  slot,
  labels,
  onDeskClaim,
}: {
  slot: PartyCardSlot;
  labels: PartyCardLabels;
  onDeskClaim?: (claimId: string, memberName: string, memberPhone?: string) => Promise<{ ok: boolean }>;
}) {
  const [claiming, setClaiming] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function handleSave() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(false);
    const res = await onDeskClaim!(slot.claimId, name.trim(), phone.trim() || undefined);
    setBusy(false);
    if (res.ok) {
      setClaiming(false);
      setName("");
      setPhone("");
    } else {
      setError(true);
    }
  }

  return (
    <li
      data-testid={`party-slot-${slot.claimId}`}
      className="flex flex-col gap-1 text-[11px]"
    >
      <div className="flex items-center gap-2">
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
        {!slot.claimed && onDeskClaim && !claiming ? (
          <button
            type="button"
            onClick={() => setClaiming(true)}
            data-testid={`party-slot-claim-btn-${slot.claimId}`}
            className="shrink-0 rounded-md bg-nq-primary/10 px-2 py-1 text-[10px] font-semibold text-nq-primary hover:bg-nq-primary/20 transition-colors"
          >
            {labels.claimOnBehalf}
          </button>
        ) : null}
      </div>

      {claiming ? (
        <div
          data-testid={`party-slot-claim-form-${slot.claimId}`}
          className="ml-6 flex flex-col gap-1.5 rounded-md border border-nq-border/50 bg-nq-surface px-2.5 py-2"
        >
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium text-nq-muted">{labels.claimNameLabel}</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={labels.claimNamePlaceholder}
              maxLength={80}
              autoFocus
              className="rounded border border-nq-border/50 bg-nq-bg px-2 py-1 text-[11px] text-nq-foreground placeholder:text-nq-muted/60 focus:outline-none focus:ring-1 focus:ring-nq-primary/50"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium text-nq-muted">{labels.claimPhoneLabel}</span>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={labels.claimPhonePlaceholder}
              className="rounded border border-nq-border/50 bg-nq-bg px-2 py-1 text-[11px] text-nq-foreground placeholder:text-nq-muted/60 focus:outline-none focus:ring-1 focus:ring-nq-primary/50"
            />
          </label>
          {error ? (
            <p className="text-[10px] text-nq-error">{labels.claimError}</p>
          ) : null}
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={!name.trim() || busy}
              onClick={handleSave}
              data-testid={`party-slot-claim-save-${slot.claimId}`}
              className={cn(
                "flex-1 rounded-md py-1 text-[11px] font-semibold transition-colors",
                "bg-nq-primary text-nq-background hover:opacity-90",
                (!name.trim() || busy) && "opacity-50 cursor-not-allowed",
              )}
            >
              {busy ? "…" : labels.claimSave}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => { setClaiming(false); setError(false); }}
              className="flex-1 rounded-md border border-nq-border/50 py-1 text-[11px] font-semibold text-nq-muted hover:text-nq-foreground transition-colors"
            >
              {labels.claimCancel}
            </button>
          </div>
        </div>
      ) : null}
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
