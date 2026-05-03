"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import type { UserMessages } from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";
import type { SalonDashboardBooking } from "@/shared/types";

import { EditBookingForm, type EditBookingFormBooking } from "./EditBookingForm";

/** Precomputed presentation values built by `ReceptionistCenter` so this leaf stays dumb. */
export type BookingDetailDrawerModel = {
  clientName: string;
  /** E.164-ish or digits for `tel:` */
  telHref: string | null;
  /** US/CA style display for copy + tel label */
  phoneDisplay: string | null;
  clientNotes: string | null;
  serviceName: string;
  staffName: string;
  statusLabel: string;
  sourceLabel: string;
  /** One line: localized date + wall-clock range */
  scheduleLine: string;
  durationLine: string;
  priceLine: string | null;
};

export interface BookingDetailDrawerProps {
  open: boolean;
  model: BookingDetailDrawerModel | null;
  onClose: () => void;
  copy: {
    title: string;
    closeAria: string;
    sectionGuest: string;
    sectionService: string;
    sectionStaff: string;
    sectionWhen: string;
    sectionStatus: string;
    sectionNotes: string;
    sectionPrice: string;
    noNotes: string;
    callGuest: (formattedDisplay: string) => string;
    nonePrice: string;
  };
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
    dayYmd: string;
    timezone: string;
    rcMessages: UserMessages["receptionist"];
    onBookingUpdated: (updated: SalonDashboardBooking) => void | Promise<void>;
  };
}

export function BookingDetailDrawer({
  open,
  model,
  onClose,
  copy,
  primaryAction,
  cancelAction,
  deskEdit,
}: BookingDetailDrawerProps) {
  const [editMode, setEditMode] = useState(false);

  const handleClose = useCallback(() => {
    setEditMode(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) setEditMode(false);
  }, [open]);

  useEffect(() => {
    setEditMode(false);
  }, [deskEdit?.booking.id]);

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, handleClose]);

  const canEditBooking =
    deskEdit !== undefined &&
    (deskEdit.booking.status === "pending" ||
      deskEdit.booking.status === "confirmed");

  const showFooter =
    (deskEdit !== undefined && editMode) ||
    primaryAction !== undefined ||
    cancelAction !== undefined ||
    (canEditBooking && !editMode);

  return (
    <div
      className={cn(
        "fixed inset-0 z-[60] md:left-auto md:right-0 md:top-0 md:h-full md:w-full md:max-w-md",
        open ? "pointer-events-auto" : "pointer-events-none",
      )}
      aria-hidden={!open}
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
          "relative ml-auto flex h-full min-h-[40dvh] w-full flex-col bg-nq-surface shadow-nq-card",
          "motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-[var(--ease-nq-out,cubic-bezier(0.22,1,0.36,1))]",
          open ? "translate-x-0" : "translate-x-full",
          "pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.5rem,env(safe-area-inset-top))]",
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
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 text-sm">
            <section className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                {copy.sectionGuest}
              </p>
              <p className="text-base font-semibold text-nq-foreground">{model.clientName}</p>
              <p className="text-nq-muted">
                <span className="text-nq-muted">{model.sourceLabel}</span>
              </p>
              {model.telHref !== null ? (
                <a
                  data-testid="booking-call-link"
                  href={`tel:${model.telHref}`}
                  className={cn(
                    "mt-2 inline-flex min-h-11 items-center justify-center rounded-lg border border-nq-primary/45 bg-nq-primary/12 px-4 text-sm font-semibold text-nq-primary",
                  )}
                >
                  {copy.callGuest(model.phoneDisplay ?? "")}
                </a>
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
              <p className="font-medium text-nq-foreground">{model.scheduleLine}</p>
              <p className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                {copy.sectionStatus}
              </p>
              <p className="font-medium text-nq-foreground">{model.statusLabel}</p>
            </section>

            <section className="space-y-1 border-t border-nq-muted/15 pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                {copy.sectionNotes}
              </p>
              {model.clientNotes?.trim() ? (
                <p className="whitespace-pre-wrap text-nq-foreground/95">{model.clientNotes}</p>
              ) : (
                <p className="italic text-nq-muted">{copy.noNotes}</p>
              )}
            </section>

            {showFooter ? (
              <div className="sticky bottom-0 mt-auto space-y-2 border-t border-nq-muted/20 bg-nq-surface pb-2 pt-3">
                {editMode && deskEdit ? (
                  <EditBookingForm
                    slug={deskEdit.slug}
                    booking={deskEdit.booking}
                    bookingId={deskEdit.booking.id}
                    salonId={deskEdit.salonId}
                    staff={deskEdit.staff}
                    services={deskEdit.services}
                    dayYmd={deskEdit.dayYmd}
                    timezone={deskEdit.timezone}
                    rcMessages={deskEdit.rcMessages}
                    onCancel={() => setEditMode(false)}
                    onSaved={(updated) => {
                      setEditMode(false);
                      void deskEdit.onBookingUpdated(updated);
                    }}
                  />
                ) : (
                  <>
                    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-3">
                      {canEditBooking && deskEdit ? (
                        <Button
                          type="button"
                          variant="secondary"
                          data-testid="edit-booking-button"
                          className="w-full sm:min-w-0 sm:flex-1"
                          onClick={() => setEditMode(true)}
                        >
                          {deskEdit.rcMessages.drawer.editBooking}
                        </Button>
                      ) : null}
                      {primaryAction !== undefined ? (
                        <Button
                          type="button"
                          variant="primary"
                          loading={primaryAction.busy}
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
                        className="w-full sm:w-full"
                        onClick={() => void cancelAction.onPress()}
                      >
                        {cancelAction.label}
                      </Button>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
