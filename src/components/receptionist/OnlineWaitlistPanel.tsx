"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { cn } from "@/shared/lib/cn";
import { displayCustomerName } from "@/shared/lib/customerDisplayName";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { getUserMessages } from "@/shared/i18n/user";
import { inviteWaitlistEntry } from "@/shared/dashboard/receptionistActions";
import type { ReceptionistCenterData } from "@/shared/dashboard/loadReceptionistCenterData";

type WaitlistEntry = ReceptionistCenterData["onlineWaitlist"][number];

export interface OnlineWaitlistPanelProps {
  slug: string;
  entries: WaitlistEntry[];
}

type RowStatus = "waiting" | "notified";

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
export function OnlineWaitlistPanel({ slug, entries }: OnlineWaitlistPanelProps) {
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
    const override = statusById[entry.id];
    if (override) return override;
    return entry.status === "notified" ? "notified" : "waiting";
  }

  return (
    <section
      data-testid="online-waitlist-panel"
      aria-label={t.title}
      className="border-t border-nq-border/40 bg-nq-surface px-3 py-3"
    >
      <header className="flex items-center justify-between gap-2 pb-2">
        <h2 className="text-sm font-semibold text-nq-foreground">{t.title}</h2>
        <span className="rounded-full bg-nq-gold/20 px-2.5 py-0.5 font-mono text-xs font-semibold tabular-nums text-nq-gold">
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
            const isPending = pendingId === entry.id;
            const name = displayCustomerName(entry.clientName, removedGuest);
            const subline =
              entry.preferredSlotLabel && entry.preferredSlotLabel.trim()
                ? `${entry.serviceName} · ${entry.bookingDate} · ${entry.preferredSlotLabel}`
                : `${entry.serviceName} · ${entry.bookingDate}`;
            return (
              <li
                key={entry.id}
                data-testid={`waitlist-entry-${entry.id}`}
                className="rounded-xl border border-nq-border/40 bg-nq-bg/40 p-2.5"
              >
                <div className="flex items-start gap-2.5">
                  <span
                    aria-hidden
                    className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-nq-gold/15 text-xs font-semibold text-nq-gold"
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
                          isNotified
                            ? "border-nq-gold/30 bg-nq-gold/10 text-nq-gold"
                            : "border-nq-border/40 text-nq-muted",
                        )}
                      >
                        {isNotified ? t.invited : t.statusWaiting}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-nq-muted">
                      {subline}
                    </p>
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => void onInvite(entry)}
                      data-testid={`waitlist-invite-${entry.id}`}
                      className={cn(
                        "mt-2 inline-flex min-h-11 w-full items-center justify-center rounded-lg px-3 text-sm font-semibold transition-opacity",
                        isNotified
                          ? "border border-nq-gold/40 bg-transparent text-nq-gold hover:bg-nq-gold/10"
                          : "bg-nq-gold text-nq-navy-deep hover:opacity-95",
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
              "border-nq-gold/40 bg-nq-gold/10 text-nq-gold",
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
