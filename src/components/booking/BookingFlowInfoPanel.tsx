"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "@/shared/lib/motionClient";
import { Button } from "@/components/ui/Button";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import {
  bookingStepVariants,
  type BookingMotionDir,
} from "@/components/booking/bookingMotion";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { BOOKING_GUEST_NAME_MAX } from "@/shared/booking/bookingGuestContactLimits";
import { cn } from "@/shared/lib/cn";
import type { ReturningCustomer } from "@/components/booking/useBookingFlowState";

/** Mask email for display: j***@domain.com */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  return `${local.slice(0, 1)}***@${domain}`;
}

export function BookingFlowInfoPanel({
  t,
  clientName,
  clientEmail,
  clientNotes,
  clientWebsite,
  salonId,
  referenceImageEnabled,
  referenceImagePath,
  referenceImagePreview,
  error,
  nameError,
  emailError,
  stepDir,
  reducedMotion,
  stepTransition,
  returningCustomer = null,
  lookupLoading = false,
  currentStaffId = null,
  onAcceptPreferredStaff,
  onDismissPreferredStaff,
  preferredStaffDismissed = false,
  onClientNameChange,
  onClientEmailChange,
  onClientNotesChange,
  onClientWebsiteChange,
  onReferenceImageChange,
  onClientNameBlur,
  onClientEmailBlur,
  onBack,
  onNext,
}: {
  t: BookingMessages;
  clientName: string;
  clientEmail: string;
  clientNotes: string;
  /** Task #09-11 honeypot — never visible to humans. Bots autofilling
   *  every input in the form will populate this; `submitPublicBooking`
   *  short-circuits with a silent fake-success when it's non-empty. */
  clientWebsite: string;
  /** Salon UUID — used for ref-upload path. */
  salonId: string;
  /** When false, the optional reference-image upload is hidden (e.g. head spa). */
  referenceImageEnabled: boolean;
  /** Storage path returned after successful upload. */
  referenceImagePath: string | null;
  /** Local object URL for preview before upload. */
  referenceImagePreview: string | null;
  error: string | null;
  nameError: string | null;
  emailError: string | null;
  stepDir: BookingMotionDir;
  reducedMotion: boolean;
  stepTransition: { duration: number; ease: [number, number, number, number] };
  /** Set when a returning customer is found by phone lookup. */
  returningCustomer?: ReturningCustomer | null;
  /** True while phone lookup API call is in-flight */
  lookupLoading?: boolean;
  /** ID of the staff currently selected by the user (null = any staff) */
  currentStaffId?: string | null;
  /** Called when the user accepts the preferred staff suggestion */
  onAcceptPreferredStaff?: (staffId: string) => void;
  /** Called when the user dismisses the preferred staff suggestion */
  onDismissPreferredStaff?: () => void;
  /** Whether the preferred staff suggestion has been dismissed this session */
  preferredStaffDismissed?: boolean;
  onClientNameChange: (v: string) => void;
  onClientEmailChange: (v: string) => void;
  onClientNotesChange: (v: string) => void;
  onClientWebsiteChange: (v: string) => void;
  /** Called with the uploaded ref_path (or null to remove). */
  onReferenceImageChange: (refPath: string | null, preview: string | null) => void;
  onClientNameBlur: () => void;
  onClientEmailBlur: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const nameRef = useRef<HTMLInputElement | null>(null);
  const emailRef = useRef<HTMLInputElement | null>(null);
  const refFileRef = useRef<HTMLInputElement | null>(null);
  const [refUploading, setRefUploading] = useState(false);
  const [refError, setRefError] = useState<string | null>(null);

  // Auto-focus the first invalid field after Continue surfaces an error.
  useEffect(() => {
    const target = nameError
      ? nameRef.current
      : emailError
        ? emailRef.current
        : null;
    if (target) {
      target.focus({ preventScroll: false });
      target.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [nameError, emailError]);

  async function handleRefFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setRefError(null);
    setRefUploading(true);
    const preview = URL.createObjectURL(file);
    const form = new FormData();
    form.append("file", file);
    form.append("salon_id", salonId);
    try {
      const res = await fetch("/api/booking/ref-upload", { method: "POST", body: form });
      const data = (await res.json()) as { ref_path?: string; error?: string };
      if (!res.ok || !data.ref_path) {
        setRefError(data.error ?? "upload_failed");
        URL.revokeObjectURL(preview);
      } else {
        onReferenceImageChange(data.ref_path, preview);
      }
    } catch {
      setRefError("upload_failed");
      URL.revokeObjectURL(preview);
    } finally {
      setRefUploading(false);
      if (refFileRef.current) refFileRef.current.value = "";
    }
  }

  function handleRemoveRef() {
    if (referenceImagePreview) URL.revokeObjectURL(referenceImagePreview);
    onReferenceImageChange(null, null);
    setRefError(null);
  }

  return (
    <motion.section
      key="info"
      role="group"
      aria-labelledby="info-heading"
      custom={stepDir}
      variants={bookingStepVariants}
      initial={reducedMotion ? false : "initial"}
      animate="animate"
      exit="exit"
      transition={stepTransition}
      className="will-change-transform"
    >
      <h2
        id="info-heading"
        className="text-lg font-semibold tracking-tight text-[var(--booking-text)] sm:text-xl lg:text-[1.625rem] lg:tracking-[-0.02em]"
      >
        {t.stepInfoHeading}
      </h2>

      <div className="mt-6 space-y-6 lg:mt-8">
        {/* Returning-customer welcome card — shown above the name field */}
        <AnimatePresence>
          {returningCustomer !== null && (
            <motion.div
              key="returning-customer-card"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="rounded-2xl bg-nq-primary/5 border border-nq-primary/20 p-4"
              data-testid="returning-customer-card"
            >
              {/* Header row: avatar + name + VIP badge */}
              <div className="flex items-start gap-3">
                {/* Avatar circle showing first letter of name */}
                <div className="w-10 h-10 rounded-full bg-nq-primary/20 text-nq-primary flex items-center justify-center font-semibold text-base shrink-0">
                  {returningCustomer.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-[var(--booking-text)] text-sm">
                      {t.returningCustomer.welcomeBack}
                    </span>
                    {returningCustomer.isVip && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-nq-warning/15 border border-nq-warning/30 px-2 py-0.5 text-[11px] font-semibold text-nq-warning">
                        ✨ {t.returningCustomer.vipBadge}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-[var(--booking-text-muted)] mt-0.5">
                    {t.returningCustomer.visitCount.replace("{n}", String(returningCustomer.visitCount))}
                  </p>
                  {returningCustomer.email && (
                    <p className="text-xs text-[var(--booking-text-muted)] mt-0.5">
                      {maskEmail(returningCustomer.email)}
                    </p>
                  )}
                </div>
              </div>

              {/* Preferred staff section */}
              {returningCustomer.preferredStaffId !== null && returningCustomer.preferredStaffName !== null && (() => {
                const staffId = returningCustomer.preferredStaffId!;
                const staffName = returningCustomer.preferredStaffName!;
                // User already selected their preferred staff — show confirmation
                if (currentStaffId === staffId) {
                  return (
                    <div className="mt-3 rounded-xl bg-[var(--booking-bg-input)] border border-[var(--booking-border)] p-3">
                      <p className="text-sm font-medium text-nq-primary">
                        {t.returningCustomer.alreadyWithPreferred.replace("{name}", staffName)}
                      </p>
                    </div>
                  );
                }
                // Show suggestion only when not dismissed and no specific other staff is selected
                if (!preferredStaffDismissed && (currentStaffId === null || currentStaffId === "any")) {
                  return (
                    <div className="mt-3 rounded-xl bg-[var(--booking-bg-input)] border border-[var(--booking-border)] p-3">
                      <p className="text-xs text-[var(--booking-text-muted)] mb-1">
                        {t.returningCustomer.preferredStaffHeading}
                      </p>
                      <p className="text-sm font-medium text-[var(--booking-text)] mb-3">
                        {t.returningCustomer.preferredStaffPrompt.replace("{name}", staffName)}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          onClick={() => onAcceptPreferredStaff?.(staffId)}
                        >
                          {t.returningCustomer.acceptPreferredStaff.replace("{name}", staffName)}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => onDismissPreferredStaff?.()}
                        >
                          {t.returningCustomer.dismissPreferredStaff}
                        </Button>
                      </div>
                    </div>
                  );
                }
                return null;
              })()}
            </motion.div>
          )}
        </AnimatePresence>

        <div>
          <label
            htmlFor="booking-info-name"
            className="mb-2 block text-sm font-medium text-[var(--booking-text)]"
          >
            {t.clientNameLabel}
          </label>
          <input
            id="booking-info-name"
            ref={nameRef}
            type="text"
            name="clientName"
            autoComplete="name"
            value={clientName}
            inputMode="text"
            autoCorrect="off"
            maxLength={BOOKING_GUEST_NAME_MAX}
            onChange={(e) => onClientNameChange(e.target.value)}
            onBlur={() => {
              void onClientNameBlur();
            }}
            aria-invalid={Boolean(nameError)}
            className={cn(
              "nq-booking-field",
              nameError && "border-nq-error/50",
            )}
            data-testid="booking-info-name"
          />
          {nameError ? (
            <p
              className="mt-1 text-xs text-nq-error"
              data-testid="booking-info-name-error"
              role="alert"
            >
              {nameError}
            </p>
          ) : null}
        </div>
        <div>
          <label
            htmlFor="booking-info-email"
            className="mb-2 block text-sm font-medium text-[var(--booking-text)]"
          >
            {t.clientEmailLabel}
          </label>
          <p className="mb-2 text-xs text-[var(--booking-text-muted)]">{t.clientEmailHint}</p>
          <input
            id="booking-info-email"
            ref={emailRef}
            type="email"
            name="clientEmail"
            autoComplete="email"
            inputMode="email"
            value={clientEmail}
            maxLength={254}
            onChange={(e) => onClientEmailChange(e.target.value)}
            onBlur={() => {
              void onClientEmailBlur();
            }}
            className={cn(
              "nq-booking-field",
              emailError && "border-nq-error/50",
            )}
            aria-invalid={Boolean(emailError)}
            data-testid="booking-info-email"
          />
          {emailError ? (
            <p
              className="mt-1 text-xs text-nq-error"
              data-testid="booking-info-email-error"
              role="alert"
            >
              {emailError}
            </p>
          ) : null}
        </div>
        <div>
          <label
            htmlFor="booking-info-notes"
            className="mb-2 block text-sm font-medium text-[var(--booking-text)]"
          >
            {t.clientNotesLabel}
          </label>
          <p className="mb-2 text-xs text-[var(--booking-text-muted)]">{t.clientNotesOptionalHint}</p>
          <textarea
            id="booking-info-notes"
            name="clientNotes"
            rows={3}
            maxLength={2000}
            value={clientNotes}
            onChange={(e) => onClientNotesChange(e.target.value)}
            className="nq-booking-field min-h-[5.5rem] resize-y py-3"
          />
        </div>

        {/* Reference / inspiration image — optional (vertical/salon gated) */}
        {referenceImageEnabled ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-[var(--booking-text)]">
            {t.refImageLabel}
          </p>
          <p className="text-xs text-[var(--booking-text-muted)]">{t.refImageHelp}</p>
          {referenceImagePath && referenceImagePreview ? (
            <div className="relative w-32 h-32 rounded-xl overflow-hidden border border-[var(--booking-border)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={referenceImagePreview} alt="Reference" className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={handleRemoveRef}
                className="absolute top-1 right-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white"
              >
                {t.refImageRemove}
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={refUploading}
              onClick={() => refFileRef.current?.click()}
              className="flex h-20 w-32 items-center justify-center rounded-xl border-2 border-dashed border-[var(--booking-border)] text-xs text-[var(--booking-text-muted)] disabled:opacity-50"
            >
              {refUploading ? t.refImageUploading : "📎 Upload"}
            </button>
          )}
          <input
            ref={refFileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => void handleRefFileChange(e)}
          />
          {refError && (
            <p className="text-xs text-nq-error">{refError === "file_too_large" ? "Max 5 MB" : "Upload failed. Please try again."}</p>
          )}
        </div>
        ) : null}

        {/*
         * Task #09-11 — honeypot. Hidden three ways (off-screen, no
         * display, tabIndex -1, aria-hidden) so screen readers and
         * keyboard users never reach it. Real humans cannot fill this
         * field. Naive form-fillers / bots will populate every `<input>`
         * regardless and trip the server-side guard, which returns a
         * silent fake-success without writing a row.
         *
         * `name="website"` is a deliberate decoy — it's a plausible
         * field name a bot would expect, increasing the odds of a fill.
         */}
        <div aria-hidden="true" style={{ display: "none" }}>
          <label htmlFor="booking-info-website">Website</label>
          <input
            id="booking-info-website"
            type="text"
            name="website"
            autoComplete="off"
            tabIndex={-1}
            value={clientWebsite}
            onChange={(e) => onClientWebsiteChange(e.target.value)}
          />
        </div>
        {error ? (
          <p className="text-sm text-nq-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:gap-4 lg:mt-12 lg:items-center lg:justify-between">
        <Button
          type="button"
          variant="secondary"
          className="nq-booking-glass h-14 min-h-11 w-full shrink-0 border border-[var(--booking-border)] bg-transparent text-[var(--booking-text-muted)] shadow-none hover:bg-[var(--booking-bg-input)] sm:w-auto sm:min-w-[8.5rem]"
          onClick={onBack}
        >
          {t.back}
        </Button>
        <div className="flex w-full justify-end sm:flex-1">
          {/* Continue is gated on a non-empty name and no validation errors.
              Phone was moved to the phone step — it is already validated before reaching here. */}
          <LuxuryBookingCta
            onClick={onNext}
            disabled={
              clientName.trim().length === 0 ||
              Boolean(nameError)
            }
          >
            {t.next}
          </LuxuryBookingCta>
        </div>
      </div>
    </motion.section>
  );
}
