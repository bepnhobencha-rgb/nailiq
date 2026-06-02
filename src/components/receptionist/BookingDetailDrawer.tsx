"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import type { UserMessages } from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";
import { displayCustomerName } from "@/shared/lib/customerDisplayName";
import {
  canEditBooking as roleAllowsEditBooking,
  type SalonMemberRole,
} from "@/shared/lib/salonMemberRole";
import type { BookingStatus, SalonDashboardBooking } from "@/shared/types";

import { EditBookingForm, type EditBookingFormBooking } from "./EditBookingForm";

/**
 * Booking status → Badge variant, per the locked status palette in
 * `COLOR_TOKENS.md` §5. Mirrors the timeline-block hues (`BookingBlock`)
 * so a booking's status reads the same in the grid and in this detail
 * panel (P2: color-coding consistent across both surfaces). Badge has no
 * orange/slate variant, so `waiting` borrows the warning (amber) family
 * and `cancelled` the neutral (slate-ish) family — safe here because the
 * drawer shows exactly one booking's status, always paired with its text
 * label (`COLOR_TOKENS.md` §7: never hue-only encoding).
 */
function statusBadgeVariant(status: BookingStatus): BadgeVariant {
  switch (status) {
    case "confirmed":
      return "info"; // cool blue — committed timehold
    case "in_progress":
      return "success"; // green — active chair time
    case "pending":
    case "waiting":
      return "warning"; // amber — needs attention / motion
    case "completed":
    case "cancelled":
      return "neutral"; // low-arousal muted / slate
  }
}

/** Precomputed presentation values built by `ReceptionistCenter` so this leaf stays dumb. */
export type BookingDetailDrawerModel = {
  clientName: string;
  /** E.164-ish or digits for `tel:` */
  telHref: string | null;
  /** US/CA style display for copy + tel label */
  phoneDisplay: string | null;
  /** P0.8: privacy-masked phone display, e.g. "***-***-7890".
   * Rendered by default; revealing swaps in `phoneDisplay`. Computed
   * by the caller so this leaf stays dumb about formatting. */
  phoneMasked: string | null;
  clientNotes: string | null;
  serviceName: string;
  staffName: string;
  /** Raw booking status — drives the color-coded status Badge (P2:
   * status color must read consistently across the timeline + this
   * panel). The localized text lives in `statusLabel`. */
  status: BookingStatus;
  statusLabel: string;
  sourceLabel: string;
  /** When true, render a "Khách yêu cầu thợ này" line under the
   * source. Drives operator awareness without forcing them to scan
   * the staff_request_note (which may be empty for online bookings). */
  staffRequestedByClient: boolean;
  /** One line: localized date + wall-clock range; reflects total span (main + add-on). */
  scheduleLine: string;
  /** Combined main + add-on duration, formatted via `durationMinutes` copy. */
  durationLine: string;
  /** Combined main + add-on price; null only when both prices are missing. */
  priceLine: string | null;
  /** Add-on service display name; null when the booking has no add-on. */
  addonServiceName: string | null;
  /** Add-on duration line (e.g. "30 minutes"); null when no add-on. */
  addonDurationLine: string | null;
  /** Smart verification method recorded on booking. */
  verificationMethod: string | null;
  /** Non-null when SMS confirmation failed — show warning badge. */
  smsFailedAt: string | null;
  /** No-show risk score 0-100. */
  noShowRiskScore: number | null;
};

export interface BookingDetailDrawerProps {
  open: boolean;
  model: BookingDetailDrawerModel | null;
  onClose: () => void;
  copy: {
    title: string;
    closeAria: string;
    /** Localized label for a redacted/removed customer ("[removed]" in DB). */
    removedGuest: string;
    sectionGuest: string;
    sectionService: string;
    sectionStaff: string;
    sectionWhen: string;
    sectionStatus: string;
    sectionNotes: string;
    sectionPrice: string;
    sectionAddon: string;
    noNotes: string;
    callGuest: (formattedDisplay: string) => string;
    /** P0.8: short "Call" label (no phone embedded) for the masked
     * phone block — full number only appears in the masked/revealed
     * display above. */
    callGuestShort: string;
    /** P0.8 phone-privacy labels. */
    phoneSection: string;
    revealPhone: string;
    hidePhone: string;
    nonePrice: string;
    /** "❤️ Khách yêu cầu thợ này" line under the source label. */
    staffRequestedByClient: string;
  };
  /** Caller's `salon_members.role` — gates Edit (Cancel is gated upstream). */
  viewerRole: SalonMemberRole;
  /**
   * Realtime offline guard — when true, all footer mutation buttons
   * (Edit, primary, cancel) are disabled and an inline offline hint
   * is rendered above the row. Mutation guard for `ConnectionBanner`
   * state — prevents writes against stale data when the realtime
   * channel is closed/erroring.
   */
  isOffline?: boolean;
  /** Localized "Offline — editing unavailable" hint. */
  offlineEditDisabledHint?: string;
  /** Primary footer CTA (start or mark complete), when applicable. */
  primaryAction?: {
    label: string;
    busy: boolean;
    onPress: () => void | Promise<void>;
  };
  /** Destructive cancel; parent should confirm before calling onPress. */
  cancelAction?: {
    label: string;
    busy: boolean;
    onPress: () => void | Promise<void>;
  };
  /** Restore a cancelled booking back to confirmed (owner / senior only). */
  restoreAction?: {
    label: string;
    busy: boolean;
    onPress: () => void | Promise<void>;
  };
  /** Decline a Wix-origin pending booking (→ declined on Wix). Owner / senior only. */
  declineAction?: {
    label: string;
    busy: boolean;
    onPress: () => void | Promise<void>;
  };
  /** Mark a past confirmed/in-progress booking as a no-show. Owner / senior only. */
  noShowAction?: {
    label: string;
    busy: boolean;
    onPress: () => void | Promise<void>;
  };
  /** Inline edit (pending | confirmed); optional so presentational tests can omit. */
  deskEdit?: {
    slug: string;
    salonId: string;
    booking: EditBookingFormBooking;
    staff: { id: string; name: string }[];
    services: {
      id: string;
      name: string;
      price_cents: number;
      duration_minutes: number;
      buffer_minutes: number;
    }[];
    /** Per-staff service whitelist for the salon. `null` = no rows → all-capable fallback. */
    capabilityRows: { staff_id: string; service_id: string }[] | null;
    dayYmd: string;
    timezone: string;
    rcMessages: UserMessages["receptionist"];
    /** P0.2 — currency for the inline edit form's price preview. */
    currency: import("@/shared/lib/currencyFormat").Currency;
    onBookingUpdated: (updated: SalonDashboardBooking) => void | Promise<void>;
  };
}

export function BookingDetailDrawer({
  open,
  model,
  onClose,
  copy,
  viewerRole,
  isOffline = false,
  offlineEditDisabledHint,
  primaryAction,
  cancelAction,
  restoreAction,
  declineAction,
  noShowAction,
  deskEdit,
}: BookingDetailDrawerProps) {
  const [editMode, setEditMode] = useState(false);
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);
  // P0.8 — phone is masked by default; receptionist must explicitly
  // tap "Show number" to reveal. Resets whenever the drawer closes or
  // switches to a different booking, so an unrelated open never leaks
  // the previous customer's full digits.
  const [phoneRevealed, setPhoneRevealed] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- portal target is only available client-side
    setPortalEl(document.body);
  }, []);

  const handleClose = useCallback(() => {
    setEditMode(false);
    onClose();
  }, [onClose]);

  /* eslint-disable react-hooks/set-state-in-effect -- ARCHITECTURE_LOCK: exit edit mode + reset phone reveal when drawer closes */
  useEffect(() => {
    if (!open) {
      setEditMode(false);
      setPhoneRevealed(false);
    }
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- exit edit mode + re-mask when drawer rebinds to a different booking
    setEditMode(false);
    setPhoneRevealed(false);
  }, [deskEdit?.booking.id]);

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, handleClose]);

  // Edit visibility = booking is in an editable status AND viewer's role
  // allows it. `roleAllowsEditBooking` is the role-side gate (owner/senior
  // yes, nail_tech no); the status check is the booking-state gate.
  // P1.12 — `in_progress` bookings are now editable too: receptionists
  // sometimes need to add a service / shift staff after the chair is
  // already in use. Cancel from in_progress was already allowed
  // (`drawerCancelAction`), so this just unifies the surface.
  const canEditBooking =
    deskEdit !== undefined &&
    roleAllowsEditBooking(viewerRole) &&
    (deskEdit.booking.status === "pending" ||
      deskEdit.booking.status === "confirmed" ||
      deskEdit.booking.status === "in_progress");

  const showFooter =
    (deskEdit !== undefined && editMode) ||
    primaryAction !== undefined ||
    cancelAction !== undefined ||
    declineAction !== undefined ||
    noShowAction !== undefined ||
    (canEditBooking && !editMode);

  const sheet = (
    <div
      className={cn(
        "fixed inset-0 z-[60] w-full md:inset-y-0 md:left-auto md:right-0 md:h-[100dvh] md:w-[min(480px,90vw)]",
        open ? "pointer-events-auto" : "pointer-events-none",
      )}
      aria-hidden={!open}
      inert={!open}
    >
      <button
        type="button"
        aria-label={copy.closeAria}
        tabIndex={open ? 0 : -1}
        className={cn(
          "absolute inset-0 bg-nq-bg/70 backdrop-blur-[2px]",
          "motion-safe:transition-opacity motion-safe:duration-[var(--duration-nq-fast,180ms)]",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={handleClose}
      />

      <div
        data-testid="booking-detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nq-booking-detail-title"
        className={cn(
          "relative ml-auto flex h-full min-h-[40dvh] min-w-0 max-w-full flex-col overflow-hidden bg-nq-surface shadow-nq-card",
          "motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-[var(--ease-nq-out,cubic-bezier(0.22,1,0.36,1))]",
          open ? "translate-x-0" : "translate-x-full",
          "pt-[max(0.5rem,env(safe-area-inset-top))]",
        )}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-nq-muted/20 px-4 py-3">
          <h2
            id="nq-booking-detail-title"
            className="truncate text-lg font-semibold text-nq-foreground"
          >
            {copy.title}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className={cn(
              "min-h-10 min-w-10 shrink-0 rounded-lg border border-nq-muted/40 text-sm font-medium text-nq-muted",
              "hover:border-nq-muted hover:text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/40",
            )}
            aria-label={copy.closeAria}
          >
            ✕
          </button>
        </header>

        {model ? (
          <>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden px-4 py-4 text-sm">
              <section className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                  {copy.sectionGuest}
                </p>
                <p className="text-base font-semibold text-nq-foreground">{displayCustomerName(model.clientName, copy.removedGuest)}</p>
                <p className="text-nq-muted">
                  <span className="text-nq-muted">{model.sourceLabel}</span>
                </p>
                {model.staffRequestedByClient ? (
                  <p
                    className="inline-flex items-center gap-1.5 text-nq-foreground"
                    data-testid="booking-drawer-staff-requested"
                  >
                    <span aria-hidden>❤️</span>
                    <span>{copy.staffRequestedByClient}</span>
                  </p>
                ) : null}
                {model.telHref !== null ? (
                  // P0.8 — phone privacy: masked-by-default display +
                  // explicit reveal toggle. The `tel:` link always
                  // dials the real number regardless of reveal state,
                  // so the receptionist can hit Call without showing
                  // the digits to anyone behind them.
                  <div
                    className="mt-2 space-y-1.5"
                    data-testid="booking-drawer-phone-block"
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                      {copy.phoneSection}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        data-testid="booking-drawer-phone-display"
                        data-phone-revealed={phoneRevealed ? "true" : "false"}
                        className="font-mono text-sm tabular-nums text-nq-foreground"
                      >
                        {phoneRevealed
                          ? model.phoneDisplay ?? ""
                          : model.phoneMasked ?? ""}
                      </span>
                      <button
                        type="button"
                        data-testid="booking-drawer-phone-toggle"
                        onClick={() => setPhoneRevealed((v) => !v)}
                        className="inline-flex min-h-8 items-center rounded-md border border-nq-muted/40 px-2 py-1 text-xs font-medium text-nq-muted hover:border-nq-muted hover:text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/40"
                      >
                        {phoneRevealed ? copy.hidePhone : copy.revealPhone}
                      </button>
                    </div>
                    <a
                      data-testid="booking-call-link"
                      href={`tel:${model.telHref}`}
                      className={cn(
                        "mt-1 inline-flex min-h-11 items-center justify-center rounded-lg border border-nq-primary/45 bg-nq-primary/12 px-4 text-sm font-semibold text-nq-primary",
                      )}
                    >
                      {copy.callGuestShort}
                    </a>
                  </div>
                ) : null}
              </section>

            <section className="space-y-1 border-t border-nq-muted/15 pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                {copy.sectionService}
              </p>
              <p className="font-medium text-nq-foreground">{model.serviceName}</p>
              <p className="text-nq-muted">{model.durationLine}</p>
              {model.priceLine ? (
                <p className="mt-2 text-xs text-nq-muted">
                  <span className="font-semibold uppercase tracking-wide">{copy.sectionPrice}</span>
                  {": "}
                  <span className="font-medium text-nq-foreground">{model.priceLine}</span>
                </p>
              ) : (
                <p className="mt-2 text-xs text-nq-muted">
                  <span className="font-semibold uppercase tracking-wide">{copy.sectionPrice}</span>
                  {": "}
                  {copy.nonePrice}
                </p>
              )}
            </section>

            {model.addonServiceName ? (
              <section
                className="space-y-1 border-t border-nq-muted/15 pt-4"
                data-testid="booking-drawer-addon"
              >
                <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                  {copy.sectionAddon}
                </p>
                <p className="font-medium text-nq-foreground">
                  {model.addonServiceName}
                </p>
                {model.addonDurationLine ? (
                  <p className="text-nq-muted">{model.addonDurationLine}</p>
                ) : null}
              </section>
            ) : null}

            <section className="space-y-1 border-t border-nq-muted/15 pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                {copy.sectionStaff}
              </p>
              <p className="font-medium text-nq-foreground">{model.staffName}</p>
            </section>

            <section className="space-y-1 border-t border-nq-muted/15 pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                {copy.sectionWhen}
              </p>
              <p
                data-testid="booking-drawer-schedule"
                className="font-medium text-nq-foreground"
              >
                {model.scheduleLine}
              </p>
              <p className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                {copy.sectionStatus}
              </p>
              <div className="mt-0.5">
                <Badge
                  variant={statusBadgeVariant(model.status)}
                  size="md"
                  data-testid="booking-drawer-status-badge"
                >
                  {model.statusLabel}
                </Badge>
              </div>

              {/* Verification + SMS badges */}
              {(model.smsFailedAt || model.verificationMethod || (model.noShowRiskScore != null && model.noShowRiskScore >= 70)) ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {model.smsFailedAt ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-400">
                      ⚠ SMS không gửi được
                    </span>
                  ) : null}
                  {model.verificationMethod === "otp" ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                      ✓ Đã verify OTP
                    </span>
                  ) : null}
                  {model.verificationMethod === "deposit" ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                      💰 Đã đặt cọc
                    </span>
                  ) : null}
                  {model.noShowRiskScore != null && model.noShowRiskScore >= 70 && !model.verificationMethod ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-red-400/40 bg-red-400/10 px-2 py-0.5 text-[11px] font-medium text-red-400">
                      ⚠ Rủi ro cao chưa verify ({model.noShowRiskScore})
                    </span>
                  ) : null}
                </div>
              ) : null}
            </section>

            <section className="space-y-1 border-t border-nq-muted/15 pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                {copy.sectionNotes}
              </p>
              {model.clientNotes?.trim() ? (
                <p className="break-words whitespace-pre-wrap text-nq-foreground/95">
                  {model.clientNotes}
                </p>
              ) : (
                <p className="italic text-nq-muted">{copy.noNotes}</p>
              )}
              </section>
            </div>

            {showFooter ? (
              <div
                className={cn(
                  "flex shrink-0 flex-col gap-2 border-t border-nq-muted/20 bg-nq-surface px-4 pt-3",
                  "pb-[max(1rem,env(safe-area-inset-bottom))]",
                )}
              >
                {editMode && deskEdit ? (
                  <EditBookingForm
                    slug={deskEdit.slug}
                    booking={deskEdit.booking}
                    bookingId={deskEdit.booking.id}
                    salonId={deskEdit.salonId}
                    staff={deskEdit.staff}
                    services={deskEdit.services}
                    capabilityRows={deskEdit.capabilityRows}
                    dayYmd={deskEdit.dayYmd}
                    timezone={deskEdit.timezone}
                    rcMessages={deskEdit.rcMessages}
                    currency={deskEdit.currency}
                    isOffline={isOffline}
                    offlineEditDisabledHint={offlineEditDisabledHint}
                    onCancel={() => setEditMode(false)}
                    onSaved={(updated) => {
                      setEditMode(false);
                      void deskEdit.onBookingUpdated(updated);
                    }}
                  />
                ) : (
                  <>
                    {isOffline && offlineEditDisabledHint ? (
                      <p
                        className="text-xs font-semibold text-nq-error"
                        role="status"
                        data-testid="drawer-offline-hint"
                      >
                        {offlineEditDisabledHint}
                      </p>
                    ) : null}
                    <div className="flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-3">
                      {canEditBooking && deskEdit ? (
                        <Button
                          type="button"
                          variant="secondary"
                          data-testid="edit-booking-button"
                          className="w-full sm:min-w-0 sm:flex-1"
                          disabled={isOffline}
                          title={isOffline ? offlineEditDisabledHint : undefined}
                          onClick={() => setEditMode(true)}
                        >
                          {deskEdit.rcMessages.drawer.editBooking}
                        </Button>
                      ) : null}
                      {primaryAction !== undefined ? (
                        <Button
                          type="button"
                          variant="primary"
                          data-testid="drawer-primary-action"
                          loading={primaryAction.busy}
                          disabled={isOffline}
                          title={isOffline ? offlineEditDisabledHint : undefined}
                          className={cn(
                            "w-full sm:min-w-0",
                            canEditBooking ? "sm:flex-1" : "sm:w-full",
                          )}
                          onClick={() => void primaryAction.onPress()}
                        >
                          {primaryAction.label}
                        </Button>
                      ) : null}
                    </div>
                    {cancelAction !== undefined ? (
                      <Button
                        type="button"
                        variant="danger"
                        loading={cancelAction.busy}
                        data-testid="drawer-cancel-booking"
                        disabled={isOffline}
                        title={isOffline ? offlineEditDisabledHint : undefined}
                        className="w-full sm:w-full"
                        onClick={() => void cancelAction.onPress()}
                      >
                        {cancelAction.label}
                      </Button>
                    ) : null}
                    {restoreAction !== undefined ? (
                      <Button
                        type="button"
                        variant="secondary"
                        loading={restoreAction.busy}
                        data-testid="drawer-restore-booking"
                        disabled={isOffline}
                        title={isOffline ? offlineEditDisabledHint : undefined}
                        className="w-full sm:w-full"
                        onClick={() => void restoreAction.onPress()}
                      >
                        {restoreAction.label}
                      </Button>
                    ) : null}
                    {declineAction !== undefined ? (
                      <Button
                        type="button"
                        variant="danger"
                        loading={declineAction.busy}
                        data-testid="drawer-decline-wix"
                        disabled={isOffline}
                        title={isOffline ? offlineEditDisabledHint : undefined}
                        className="w-full sm:w-full"
                        onClick={() => void declineAction.onPress()}
                      >
                        {declineAction.label}
                      </Button>
                    ) : null}
                    {noShowAction !== undefined ? (
                      <Button
                        type="button"
                        variant="secondary"
                        loading={noShowAction.busy}
                        data-testid="drawer-no-show"
                        disabled={isOffline}
                        title={isOffline ? offlineEditDisabledHint : undefined}
                        className="w-full sm:w-full"
                        onClick={() => void noShowAction.onPress()}
                      >
                        {noShowAction.label}
                      </Button>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );

  if (!portalEl) return null;

  return createPortal(sheet, portalEl);
}
