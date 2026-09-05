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
import { classifyCapacityRescueAutonomy } from "@/shared/booking/capacityRescueAutonomy";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Drawer } from "@/components/ui/Drawer";
import type {
  WaitlistChannelDeliveryTruth,
  WaitlistDeliveryTruth,
} from "@/shared/noshow/waitlistDeliveryTruth";

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

type InvitationOverride = {
  status: "notified";
  delivery: WaitlistDeliveryTruth;
};

function initialOf(name: string): string {
  const c = name.trim().charAt(0);
  return c ? c.toUpperCase() : "?";
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `••• ••• ${digits.slice(-4)}` : "••••";
}

function maskEmail(email: string): string {
  const [local, domain] = email.trim().split("@");
  if (!local || !domain) return "—";
  return `${local.slice(0, 1)}•••@${domain}`;
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
  const [invitationById, setInvitationById] = useState<
    Record<string, InvitationOverride>
  >({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [selectedEntry, setSelectedEntry] = useState<WaitlistEntry | null>(null);
  const [drawerVariant, setDrawerVariant] = useState<"bottom" | "right">(
    "bottom",
  );
  const toastTimer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const update = () => setDrawerVariant(media.matches ? "right" : "bottom");
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  function flashToast(next: NonNullable<ToastState>) {
    setToast(next);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }

  async function copyContact(value: string, successText: string) {
    try {
      await navigator.clipboard.writeText(value);
      flashToast({ kind: "success", text: successText });
    } catch {
      flashToast({ kind: "error", text: t.copyFailed });
    }
  }

  async function onInvite(entry: WaitlistEntry) {
    if (pendingId !== null) return;
    setPendingId(entry.id);
    const name = displayCustomerName(entry.clientName, removedGuest);
    try {
      const res = await inviteWaitlistEntry(slug, entry.id);
      if (res.ok) {
        // Render only the durable delivery result returned by the server. The
        // offer can be open while both customer channels still need attention.
        setInvitationById((prev) => ({
          ...prev,
          [entry.id]: { status: "notified", delivery: res.delivery },
        }));
        const sentChannels = [
          res.delivery.sms.status === "sent" ? t.smsChannel : null,
          res.delivery.email.status === "sent" ? t.emailChannel : null,
        ].filter((channel): channel is string => channel !== null);
        const channels = [res.delivery.sms, res.delivery.email];
        const needsAttention = channels.some((channel) =>
          ["failed", "unknown", "suppressed", "unavailable"].includes(
            channel.status,
          ),
        );
        const stillSending = channels.some((channel) =>
          channel.status === "pending" || channel.status === "sending",
        );
        if (sentChannels.length > 0) {
          flashToast({
            kind: needsAttention ? "info" : "success",
            text: t.deliveryResultToast(
              name,
              sentChannels.join(" + "),
              needsAttention,
            ),
          });
        } else if (stillSending) {
          flashToast({ kind: "info", text: t.deliveryPendingToast(name) });
        } else {
          flashToast({ kind: "error", text: t.deliveryFailedToast(name) });
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
    const override = invitationById[entry.id];
    if (override) return override.status;
    if (entry.status === "review_required") return "review_required";
    return entry.status === "notified" ? "notified" : "waiting";
  }

  function effectiveDelivery(entry: WaitlistEntry): WaitlistDeliveryTruth {
    return invitationById[entry.id]?.delivery ?? entry.delivery;
  }

  function deliveryBadge(
    channelLabel: string,
    delivery: WaitlistChannelDeliveryTruth,
  ) {
    let label = t.deliveryStatus.unavailable;
    let variant: BadgeVariant = "neutral";
    if (delivery.status === "sent") {
      label = t.deliveryStatus.sent;
      variant = "success";
    } else if (delivery.status === "pending" || delivery.status === "sending") {
      label = t.deliveryStatus.sending;
      variant = "info";
    } else if (delivery.status === "failed") {
      label = t.deliveryStatus.failed;
      variant = "danger";
    } else if (delivery.status === "unknown") {
      label = t.deliveryStatus.unknown;
      variant = "warning";
    } else if (delivery.status === "suppressed") {
      variant = "warning";
      label = delivery.reason === "channel_disabled"
        ? t.deliveryStatus.channelDisabled
        : delivery.reason === "recipient_missing"
          ? t.deliveryStatus.recipientMissing
          : delivery.reason === "recipient_suppressed"
            ? t.deliveryStatus.recipientSuppressed
            : t.deliveryStatus.unknown;
    }
    return (
      <Badge variant={variant} state="subtle" size="md" dot>
        {channelLabel} · {label}
      </Badge>
    );
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
            const delivery = effectiveDelivery(entry);
            const isNotified = status === "notified";
            const isClaimed = status === "claimed";
            const isReviewRequired = status === "review_required";
            const isPending = pendingId === entry.id;
            const autonomy = classifyCapacityRescueAutonomy({
              requestKind: entry.requestKind,
              status,
            });
            const autonomyCopy = t.autonomy;
            const autonomyLabel = autonomy.lane === "auto_safe"
              ? autonomyCopy.autoSafe
              : autonomy.lane === "approval_required"
                ? autonomyCopy.approvalRequired
                : autonomyCopy.humanException;
            const autonomyDescription = autonomy.reason === "watching_for_exact_slot"
              ? autonomyCopy.watchingForExactSlot
              : autonomy.reason === "customer_response_pending"
                ? autonomyCopy.customerResponsePending
                : autonomy.reason === "exact_plan_required"
                  ? autonomyCopy.exactPlanRequired
                  : autonomy.reason === "booking_commit_pending"
                    ? autonomyCopy.bookingCommitPending
                    : autonomyCopy.unsafeStateCombination;
            const requiresStaffReview =
              !isClaimed && autonomy.lane !== "auto_safe";
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
                      <button
                        type="button"
                        onClick={() => setSelectedEntry(entry)}
                        aria-label={t.openCustomerDetails(name)}
                        className="min-h-11 min-w-0 truncate rounded-md text-left text-sm font-medium text-nq-foreground underline decoration-nq-border underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-nq-primary"
                      >
                        {name}
                      </button>
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
                    <div
                      data-testid={`waitlist-autonomy-${entry.id}`}
                      data-autonomy-lane={autonomy.lane}
                      className={cn(
                        "mt-2 rounded-lg border px-2.5 py-2",
                        autonomy.lane === "auto_safe"
                          ? "border-nq-success/30 bg-nq-success/5"
                          : autonomy.lane === "approval_required"
                            ? "border-nq-warning/30 bg-nq-warning/5"
                            : "border-nq-border/50 bg-nq-surface",
                      )}
                    >
                      <p className={cn(
                        "text-xs font-semibold",
                        autonomy.lane === "auto_safe"
                          ? "text-nq-success"
                          : autonomy.lane === "approval_required"
                            ? "text-nq-warning"
                            : "text-nq-foreground",
                      )}>
                        {autonomyLabel}
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-nq-muted">
                        {autonomyDescription}
                      </p>
                      {autonomy.lane === "approval_required" &&
                      !autonomy.canShowApprovalAction ? (
                        <p className="mt-1 text-xs font-medium text-nq-warning">
                          {autonomyCopy.approvalLocked}
                        </p>
                      ) : null}
                    </div>
                    {waitingMinutes !== null ? (
                      <p
                        data-testid={`waitlist-age-${entry.id}`}
                        className="mt-1 text-xs font-semibold tabular-nums text-nq-warning"
                      >
                        {t.waitingMinutes(waitingMinutes)}
                      </p>
                    ) : null}
                    <p className="mt-0.5 truncate font-mono text-xs text-nq-muted">
                      {entry.phone.trim() ? maskPhone(entry.phone) : maskEmail(entry.email)}
                    </p>
                    {(isNotified || isClaimed) ? (
                      <div
                        className="mt-2 flex flex-wrap gap-2"
                        aria-label={t.deliveryHeading}
                        data-testid={`waitlist-delivery-${entry.id}`}
                      >
                        {deliveryBadge(t.smsChannel, delivery.sms)}
                        {deliveryBadge(t.emailChannel, delivery.email)}
                      </div>
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
                    ) : requiresStaffReview ? (
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

      <Drawer
        isOpen={selectedEntry !== null}
        onClose={() => setSelectedEntry(null)}
        variant={drawerVariant}
        size="md"
        title={selectedEntry ? displayCustomerName(selectedEntry.clientName, removedGuest) : t.detailsTitle}
        description={t.detailsDescription}
        closeButtonLabel={t.closeDetails}
      >
        {selectedEntry ? (
          <div data-testid="waitlist-customer-details" className="space-y-5">
            <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-nq-muted">{t.fullName}</dt>
                <dd className="mt-1 text-nq-foreground">
                  {displayCustomerName(selectedEntry.clientName, removedGuest)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-nq-muted">{t.statusLabel}</dt>
                <dd className="mt-1 text-nq-foreground">
                  {effectiveStatus(selectedEntry) === "claimed"
                    ? t.claimed
                    : effectiveStatus(selectedEntry) === "review_required"
                      ? t.needsPlan
                      : effectiveStatus(selectedEntry) === "notified"
                        ? t.invited
                        : t.statusWaiting}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-nq-muted">{t.phoneLabel}</dt>
                <dd className="mt-1 break-all font-mono text-nq-foreground">
                  {selectedEntry.phone || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-nq-muted">{t.emailLabel}</dt>
                <dd className="mt-1 break-all text-nq-foreground">
                  {selectedEntry.email || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-nq-muted">{t.serviceLabel}</dt>
                <dd className="mt-1 text-nq-foreground">{selectedEntry.serviceName}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-nq-muted">{t.dateLabel}</dt>
                <dd className="mt-1 text-nq-foreground">{selectedEntry.bookingDate}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-nq-muted">{t.timeLabel}</dt>
                <dd className="mt-1 text-nq-foreground">
                  {selectedEntry.preferredSlotLabel || t.anyTime}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-nq-muted">{t.staffLabel}</dt>
                <dd className="mt-1 text-nq-foreground">
                  {selectedEntry.preferredStaffName || t.anyStaff}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-nq-muted">{t.joinedAtLabel}</dt>
                <dd className="mt-1 text-nq-foreground">
                  {selectedEntry.createdAt
                    ? new Intl.DateTimeFormat(language === "vi" ? "vi-VN" : "en-CA", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(selectedEntry.createdAt))
                    : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-nq-muted">{t.waitingLabel}</dt>
                <dd className="mt-1 text-nq-foreground">
                  {(() => {
                    const minutes = waitlistAgeMinutes(
                      selectedEntry.createdAt,
                      observedAtIso ?? new Date().toISOString(),
                    );
                    return minutes === null ? "—" : t.waitingMinutes(minutes);
                  })()}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-nq-muted">{t.requestKindLabel}</dt>
                <dd className="mt-1 text-nq-foreground">
                  {selectedEntry.requestKind === "group"
                    ? t.groupRequest(selectedEntry.partySize, selectedEntry.serviceCount)
                    : selectedEntry.requestKind === "sequence"
                      ? t.sequenceRequest(selectedEntry.serviceCount)
                      : t.individualRequest}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-nq-muted">{t.sourceLabel}</dt>
                <dd className="mt-1 text-nq-foreground">
                  {t.source[selectedEntry.source]}
                </dd>
              </div>
            </dl>

            <div>
              <p className="mb-2 text-xs font-medium text-nq-muted">{t.deliveryHeading}</p>
              <div className="flex flex-wrap gap-2">
                {deliveryBadge(t.smsChannel, effectiveDelivery(selectedEntry).sms)}
                {deliveryBadge(t.emailChannel, effectiveDelivery(selectedEntry).email)}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {selectedEntry.phone ? (
                <a
                  href={`tel:${selectedEntry.phone.replace(/[^+\d]/g, "")}`}
                  className="inline-flex min-h-11 items-center justify-center rounded-lg bg-nq-primary px-3 text-sm font-semibold text-nq-bg"
                >
                  {t.callCustomer}
                </a>
              ) : null}
              {selectedEntry.phone ? (
                <button
                  type="button"
                  onClick={() => void copyContact(selectedEntry.phone, t.phoneCopied)}
                  className="min-h-11 rounded-lg border border-nq-border px-3 text-sm font-semibold text-nq-foreground"
                >
                  {t.copyPhone}
                </button>
              ) : null}
              {selectedEntry.email ? (
                <button
                  type="button"
                  onClick={() => void copyContact(selectedEntry.email, t.emailCopied)}
                  className="min-h-11 rounded-lg border border-nq-border px-3 text-sm font-semibold text-nq-foreground"
                >
                  {t.copyEmail}
                </button>
              ) : null}
              {effectiveStatus(selectedEntry) === "claimed" && onCreateBooking ? (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedEntry(null);
                    onCreateBooking(selectedEntry);
                  }}
                  className="min-h-11 rounded-lg bg-nq-primary px-3 text-sm font-semibold text-nq-bg"
                >
                  {t.createBooking}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </Drawer>
    </section>
  );
}
