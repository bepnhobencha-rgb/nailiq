"use client";

import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

/**
 * Shows a Square deposit payment link as a scannable QR + copyable URL so the
 * receptionist can have the customer pay the deposit on the spot. Display-only:
 * the link is created by the `requestDepositLink` server action.
 */
export function DepositLinkModal({
  open,
  onClose,
  url,
  amountCents,
}: {
  open: boolean;
  onClose: () => void;
  url: string;
  amountCents: number;
}) {
  const [copied, setCopied] = useState(false);
  const amount = `$${(amountCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can still read the URL */
    }
  }

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      size="sm"
      title="Link đặt cọc"
      description={`Khách quét mã hoặc mở link để trả cọc ${amount}.`}
    >
      <div className="flex flex-col items-center gap-4 py-2">
        {url ? (
          <div className="rounded-xl bg-white p-3">
            <QRCodeSVG value={url} size={184} bgColor="#ffffff" fgColor="#0b0c10" level="M" />
          </div>
        ) : null}

        <div className="text-center text-2xl font-semibold text-nq-foreground">{amount}</div>

        <div className="flex w-full items-center gap-2">
          <input
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 truncate rounded-lg border border-nq-muted/30 bg-nq-surface px-3 py-2 text-sm text-nq-foreground"
          />
          <Button type="button" variant="secondary" onClick={() => void copy()}>
            {copied ? "✓ Đã chép" : "Chép link"}
          </Button>
        </div>

        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-nq-accent underline underline-offset-2"
        >
          Mở trang thanh toán Square ↗
        </a>
      </div>
    </Modal>
  );
}
