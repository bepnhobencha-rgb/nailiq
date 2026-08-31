"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { cn } from "@/shared/lib/cn";
import { displayCustomerName } from "@/shared/lib/customerDisplayName";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { getUserMessages } from "@/shared/i18n/user";
import { inviteWaitlistEntry } from "@/shared/dashboard/receptionistActions";
import type { ReceptionistCenterData } from "@/shared/dashboard/loadReceptionistCenterData";
import { waitlistAgeMinutes } from "@/shared/dashboard/waitlistAttention";

type WaitlistEntry = ReceptionistCenterData["onlineWaitlist"][number];

export interface OnlineWaitlistPanelProps {
  slug: string;
  entries: WaitlistEntry[];
  /** Pilot-only urgency copy. Kept off for salons without the release flag. */
  attentionEnabled?: boolean;
  /** Server-owned clock snapshot; avoids client/server time drift. */
  observedAtIso?: string;
  /** Open the prefilled desk booking form for a claimed waitlist entry so
   *  staff confirm time/staff and create the real appointment. */
  onCreateBooking?: (entry: WaitlistEntry) => void;
}

type RowStatus = "waiting" | "review_required" | "notified" | "claimed";

type ToastState = { kind: "success" | "info" | "error"; text: string } | null;

function initialOf(name: string): string {
  const c = name.trim().charAt(0);
  return c ? c.toUpperCase() : "?";
}

/**
 * Online waitlist panel for the Receptionist Center — sits next to the walk-in
 * queue so staff see online customers waiting for a full slot and can invite
 * one in a single tap (texts them the claim link via SMS). Bilingual via
 * `useUserLanguage`; no hardcoded user-facing strings (toast/labels live in
 * the user i18n dictionaries under `receptionist.waitlist`).
 */
export function OnlineWaitlistPanel({
  slug,
  entries,
  attentionEnabled = false,
  observedAtIso,
  onCreateBooking,
}: OnlineWaitlistPanelProps) {
  const router = useRouter();
  const { language } = useUserLanguage();
  const t = getUserMessages(language).receptionist.waitlist;
  const removedGuest = getUserMessages(language).receptionist.removedGuest;

  // Local optimistic status overrides (entryId → 'notified') so a freshly
  // invited row flips its pill before router.refresh() re-runs the loader.
  const [statusById, setStatusById] = useState<Record<string, RowStatus>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const toastTimer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  function flashToast(next: NonNullable<ToastState>) {
    setToast(next);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }

  async function onInvite(entry: WaitlistEntry) {
    if (pendingId !== null) return;
    setPendingId(entry.id);
    const name = displayCustomerName(entry.clientName, removedGuest);
    try {
      const res = await inviteWaitlistEntry(slug, entry.id);
      if (res.ok) {
        // Optimistically flip the pill, then re-run the loader for the truth.
        setStatusById((prev) => ({ ...prev, [entry.id]: "notified" }));
        if (res.suppressed) {
          flashToast({ kind: "info", text: t.suppressedToast(name) });
        } else {
          flashToast({ kind: "success", text: t.invitedToast(name) });
        }
        router.refresh();
      } else {
        flashToast({ kind: "error", text: t.errorToast });
      }
    } catch {
      flashToast({ kind: "error", text: t.errorToast });
    } finally {
      setPendingId(null);
    }
  }

  function effectiveStatus(entry: WaitlistEntry): RowStatus {
    // A claimed row is terminal for this panel (no optimistic override applies).
    if (entry.status === "claimed") return "claimed";
    const override = statusById[entry.id];
    if (override) return override;
    if (entry.status === "review_required") return "review_required";
    return entry.status === "notified" ? "notified" : "waiting";
  }

  return (
    <section
      id="waitlist"
      data-testid="online-waitlist-panel"
      aria-label={t.title}
      className="scroll-mt-20 border-t border-nq-border/40 bg-nq-surface px-3 py-3"
    >
      <header className="flex items-center justify-between gap-2 pb-2">
        <h2 className="text-sm font-semibold text-nq-foreground">{t.title}</h2>
        <span className="rounded-full bg-nq-primary/20 px-2.5 py-0.5 font-mono text-xs font-semibold tabular-nums text-nq-primary">
          {entries.length}
        </span>
      </header>

      {entries.length === 0 ? (
        <p className="py-4 text-center text-xs text-nq-muted">{t.empty}</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => {
            const status = effectiveStatus(entry);
            const isNotified = status === "notified";
            const isClaimed = status === "claimed";
            const isReviewRequired = status === "review_required";
            const isPending = pendingId === entry.id;
            const name = displayCustomerName(entry.clientName, removedGuest);
            const waitingMinutes =
              attentionEnabled &&
              (status === "waiting" || status === "review_required") &&
              observedAtIso
                ? waitlistAgeMinutes(entry.createdAt, observedAtIso)
                : null;
            const requestSummary = entry.requestKind === "group"
              ? t.groupRequest(entry.partySize, entry.serviceCount)
              : entry.requestKind === "sequence"
                ? t.sequenceRequest(entry.serviceCount)
                : entry.serviceName;
            const subline = entry.preferredSlotLabel?.trim()
              ? `${requestSummary} · ${entry.bookingDate} · ${entry.preferredSlotLabel}`
              : `${requestSummary} · ${entry.bookingDate}`;
            return (
              <li
                key={entry.id}
                data-testid={`waitlist-entry-${entry.id}`}
                className={cn(
                  "rounded-xl border p-2.5",
                  isClaimed
                    ? "border-nq-success/40 bg-nq-success/5"
                    : "border-nq-border/40 bg-nq-bg/40",
                )}
              >
                <div className="flex items-start gap-2.5">
                  <span
                    aria-hidden
                    className={cn(
                      "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                      isClaimed
                        ? "bg-nq-success/15 text-nq-success"
                        : "bg-nq-primary/15 text-nq-primary",
                    )}
                  >
                    {initialOf(name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium text-nq-foreground">
                        {name}
                      </p>
                      <span
                        className={cn(
                          "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                          isClaimed
                            ? "border-nq-success/40 bg-nq-success/10 text-nq-success"
                            : isReviewRequired
                              ? "border-nq-warning/40 bg-nq-warning/10 text-nq-warning"
                            : isNotified
                              ? "border-nq-primary/30 bg-nq-primary/10 text-nq-primary"
                              : "border-nq-border/40 text-nq-muted",
                        )}
                      >
                        {isClaimed
                          ? t.claimed
                          : isReviewRequired
                            ? t.needsPlan
                          : isNotified
                            ? t.invited
                            : t.statusWaiting}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-nq-muted">
                      {subline}
                    </p>
                    {waitingMinutes !== null ? (
                      <p
                        data-testid={`waitlist-age-${entry.id}`}
                        className="mt-1 text-xs font-semibold tabular-nums text-nq-warning"
                      >
                        {t.waitingMinutes(waitingMinutes)}
                      </p>
                    ) : null}
                    {/* Staff need the phone to follow up on a claimed or complex request. */}
                    {(isClaimed || isReviewRequired) && entry.phone.trim() ? (
                      <p className="mt-0.5 truncate font-mono text-xs text-nq-muted">
                        {entry.phone}
                      </p>
                    ) : null}
                    {isClaimed ? (
                      <button
                        type="button"
                        onClick={() => onCreateBooking?.(entry)}
                        data-testid={`waitlist-create-${entry.id}`}
                        className="mt-2 inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-nq-primary px-3 text-sm font-semibold text-nq-bg transition-opacity hover:opacity-95"
                      >
                        {t.createBooking}
                      </button>
                    ) : isReviewRequired ? (
                      <a
                        href={`tel:${entry.phone.replace(/[^+\d]/g, "")}`}
                        data-testid={`waitlist-arrange-${entry.id}`}
                        className="mt-2 inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-nq-warning/40 bg-nq-warning/10 px-3 text-sm font-semibold text-nq-warning transition-opacity hover:opacity-95"
                      >
                        {t.callToArrange}
                      </a>
                    ) : (
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => void onInvite(entry)}
                        data-testid={`waitlist-invite-${entry.id}`}
                        className={cn(
                          "mt-2 inline-flex min-h-11 w-full items-center justify-center rounded-lg px-3 text-sm font-semibold transition-opacity",
                          isNotified
                            ? "border border-nq-primary/40 bg-transparent text-nq-primary hover:bg-nq-primary/10"
                            : "bg-nq-primary text-nq-bg hover:opacity-95",
                          isPending && "pointer-events-none opacity-60",
                        )}
                      >
                        {isPending ? (
                          <span
                            aria-hidden
                            className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
                          />
                        ) : isNotified ? (
                          t.inviteAgain
                        ) : (
                          t.inviteNow
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {toast ? (
        <output
          data-testid="waitlist-toast"
          aria-live="polite"
          className={cn(
            "mt-2 block rounded-lg border px-3 py-2 text-xs font-medium",
            toast.kind === "success" &&
              "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
            toast.kind === "info" &&
              "border-nq-primary/40 bg-nq-primary/10 text-nq-primary",
            toast.kind === "error" &&
              "border-nq-error/60 bg-nq-error/15 text-nq-foreground",
          )}
        >
          {toast.text}
        </output>
      ) : null}
    </section>
  );
}
