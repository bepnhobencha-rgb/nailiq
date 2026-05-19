"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { getUserMessages } from "@/shared/i18n/user";
import type { UserLanguage } from "@/shared/i18n/user/types";

type Props = {
  salonName: string;
  bookingUrl: string;
  copied: boolean;
  onCopy: () => void;
  language: UserLanguage;
};

export function DashboardEmptyShare({
  salonName,
  bookingUrl,
  copied,
  onCopy,
  language,
}: Props) {
  const t = getUserMessages(language).ownerDashboard.emptyShare;
  const [qrOpen, setQrOpen] = useState(false);

  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(bookingUrl)}&size=240x240&margin=12`;

  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center px-4 py-12 text-center">
      {/* Checkmark icon */}
      <div className="mb-5 inline-flex h-16 w-16 items-center justify-center rounded-full bg-nq-primary/10">
        <svg
          viewBox="0 0 24 24"
          width="32"
          height="32"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-nq-primary"
          aria-hidden
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>

      <h1 className="text-2xl font-semibold text-nq-foreground">
        {t.readyTitle}
      </h1>
      <p className="mt-2 max-w-sm text-sm text-nq-muted">{t.readySubtitle}</p>

      {/* Booking URL pill */}
      <div className="mt-6 flex w-full max-w-sm items-center gap-2 rounded-xl border border-nq-border bg-nq-surface px-3 py-2.5">
        <span className="min-w-0 flex-1 truncate text-left text-sm font-medium text-nq-foreground">
          {bookingUrl}
        </span>
      </div>

      {/* Action buttons */}
      <div className="mt-4 flex w-full max-w-sm flex-col gap-2.5 sm:flex-row">
        <Button
          type="button"
          variant="primary"
          className="flex-1 min-h-11"
          onClick={onCopy}
        >
          {copied ? t.copiedButton : t.copyButton}
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="flex-1 min-h-11"
          onClick={() =>
            window.open(bookingUrl, "_blank", "noopener,noreferrer")
          }
        >
          {t.openButton}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="flex-1 min-h-11"
          onClick={() => setQrOpen(true)}
        >
          {t.qrButton}
        </Button>
      </div>

      {/* QR modal */}
      <Modal
        isOpen={qrOpen}
        onClose={() => setQrOpen(false)}
        size="sm"
        title={t.qrModalTitle}
      >
        <div className="flex flex-col items-center gap-4 py-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qrSrc}
            alt={salonName}
            width={240}
            height={240}
            className="rounded-xl border border-nq-border"
          />
          <p className="text-center text-sm text-nq-muted">{bookingUrl}</p>
        </div>
      </Modal>
    </div>
  );
}
