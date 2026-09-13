"use client";

import { BookingFlowOtpPanel } from "./BookingFlowOtpPanel";
import type { BookingMessages } from "@/shared/i18n/booking/en";

/** Choice changes quote intent; verification never submits a booking. */
export function BookingPhoneDiscountChoice({
  t, shopSlug, phone, salonPhone, hasEmail, requested, verifying,
  verificationRequired, disabled, lockedReason, onStart, onVerified, onSkip,
}: {
  t: BookingMessages; shopSlug: string; phone: string; salonPhone?: string | null;
  hasEmail: boolean; requested: boolean; verifying: boolean;
  verificationRequired?: boolean; disabled?: boolean; lockedReason?: string;
  onStart: () => void; onVerified: (sessionId: string) => void; onSkip: () => void;
}) {
  if (!hasEmail && !verificationRequired && !verifying) return null;
  return (
    <section data-testid="booking-phone-discount" className="my-4 rounded-xl border border-[var(--booking-border)] bg-[var(--booking-bg-input)] p-4 text-sm text-[var(--booking-text)]">
      <p role={verificationRequired ? "alert" : undefined}>
        {lockedReason ?? (verificationRequired ? t.phoneOfferVerificationRequired : t.phoneDiscountHint)}
      </p>
      {lockedReason ? null : verifying ? (
        <BookingFlowOtpPanel
          t={t} shopSlug={shopSlug} clientPhone={phone} salonPhone={salonPhone}
          purpose="phone" emailChannelEnabled={false} stepDir={1} reducedMotion={false}
          stepTransition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          isOptional onVerified={onVerified} onSkip={onSkip} onBack={onSkip}
        />
      ) : (
        <>
          {requested && !verificationRequired ? <p className="mt-2" role="status">{t.phoneDiscountRequested}</p> : null}
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" data-testid="phone-discount-verify" disabled={disabled} onClick={onStart} className="nq-booking-btn-ghost min-h-11 px-3 disabled:opacity-50">
              {hasEmail ? t.phoneDiscountVerify : t.phoneOfferVerify}
            </button>
            <button type="button" data-testid="phone-discount-skip" disabled={disabled} onClick={onSkip} className="min-h-11 underline disabled:opacity-50">
              {verificationRequired ? t.phoneOfferSkip : t.phoneDiscountSkip}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
