"use client";

import { useEffect, useRef } from "react";
import { motion } from "@/shared/lib/motionClient";
import { bookingStepVariants, type BookingMotionDir } from "@/components/booking/bookingMotion";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import type { VerificationAction } from "@/components/booking/useBookingFlowState";
import type { VerifyDecisionResponse } from "@/app/api/booking/verify-decision/route";

type Props = {
  t: BookingMessages;
  salonId: string;
  clientPhone: string;
  serviceIds: string[];
  subtotalCents: number;
  stepDir: BookingMotionDir;
  reducedMotion: boolean;
  stepTransition: { duration: number; ease: [number, number, number, number] };
  onDecided: (action: VerificationAction) => void;
};

export function BookingFlowVerifyPanel({
  t,
  salonId,
  clientPhone,
  serviceIds,
  subtotalCents,
  stepDir,
  reducedMotion: _reducedMotion,
  stepTransition,
  onDecided,
}: Props) {
  const calledRef = useRef(false);

  useEffect(() => {
    if (calledRef.current) return;
    calledRef.current = true;

    void (async () => {
      try {
        const res = await fetch("/api/booking/verify-decision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            salon_id: salonId,
            client_phone: clientPhone,
            service_ids: serviceIds,
            subtotal_cents: subtotalCents,
          }),
        });
        const data = (await res.json()) as VerifyDecisionResponse;
        onDecided(data.action as VerificationAction);
      } catch {
        // Fail open — if the API is unreachable, don't block booking
        onDecided("none");
      }
    })();
  }, [salonId, clientPhone, serviceIds, subtotalCents, onDecided]);

  return (
    <motion.div
      key="verify"
      custom={stepDir}
      variants={bookingStepVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={stepTransition}
      className="mt-6 flex items-center justify-center py-12"
    >
      <div className="flex flex-col items-center gap-3 text-nq-muted">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-nq-primary/30 border-t-nq-primary" />
        <p className="text-sm">{t.verifyingBooking ?? "Đang xác thực…"}</p>
      </div>
    </motion.div>
  );
}
