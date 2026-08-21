"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import type { WebVoiceBookingHandoff } from "@/shared/booking/webVoiceBookingHandoff";

const VoiceBookingModal = dynamic(
  () => import("./VoiceBookingModal").then((m) => ({ default: m.VoiceBookingModal })),
  { ssr: false },
);

type Props = {
  t: BookingMessages;
  shopSlug: string;
  language?: "en" | "vi";
  onBookingHandoff: (handoff: WebVoiceBookingHandoff) => void;
};

export function VoiceBookingButton({
  t,
  shopSlug,
  language = "en",
  onBookingHandoff,
}: Props) {
  const [open, setOpen]       = useState(false);
  const [loading, setLoading] = useState(false);
  const v = t.voice;

  const handleClick = () => {
    setLoading(true);
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
    setLoading(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={loading || open}
        className="flex w-full items-center justify-center gap-2 rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] px-4 py-3 text-sm font-semibold text-[var(--booking-text)] shadow-sm hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
        aria-label={v.tapToSpeak}
      >
        {loading && !open ? (
          /* Spinner while dynamic chunk is loading */
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--salon-primary)] border-t-transparent" aria-hidden="true" />
        ) : (
          <svg
            className="h-5 w-5 text-[var(--salon-primary)]"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.75}
              d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
            />
          </svg>
        )}
        {v.tapToSpeak}
      </button>

      {open && (
        <VoiceBookingModal
          t={t}
          shopSlug={shopSlug}
          language={language}
          onBookingHandoff={onBookingHandoff}
          onClose={handleClose}
        />
      )}
    </>
  );
}
