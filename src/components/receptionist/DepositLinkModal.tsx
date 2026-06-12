"use client";

import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

/**
 * Shows a Square deposit payment link as a scannable QR + copyable URL, and
 * (when `onSendSms` is wired) lets the receptionist text the link straight to
 * the customer's phone. The link itself is created by `requestDepositLink`.
 */
const COPY = {
  en: {
    title: "Deposit link",
    desc: (a: string) => `Customer scans the code or opens the link to pay the ${a} deposit.`,
    copy: "Copy link",
    copied: "✓ Copied",
    openSquare: "Open Square checkout ↗",
    sendSms: "📱 Text link to customer",
    sending: "Sending…",
    sent: "✓ Texted to the customer",
    smsError: "Couldn't text the link — show the QR instead.",
  },
  vi: {
    title: "Link đặt cọc",
    desc: (a: string) => `Khách quét mã hoặc mở link để trả cọc ${a}.`,
    copy: "Chép link",
    copied: "✓ Đã chép",
    openSquare: "Mở trang thanh toán Square ↗",
    sendSms: "📱 Gửi link qua SMS",
    sending: "Đang gửi…",
    sent: "✓ Đã gửi SMS cho khách",
    smsError: "Không gửi được SMS — dùng mã QR cho khách.",
  },
} as const;

export function DepositLinkModal({
  open,
  onClose,
  url,
  amountCents,
  language,
  onSendSms,
}: {
  open: boolean;
  onClose: () => void;
  url: string;
  amountCents: number;
  language: "en" | "vi";
  /** Text the link to the customer; resolves true only when Twilio accepted it. */
  onSendSms?: () => Promise<boolean>;
}) {
  const [copied, setCopied] = useState(false);
  const [smsState, setSmsState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const t = COPY[language === "en" ? "en" : "vi"];
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

  async function textLink() {
    if (!onSendSms || smsState === "sending") return;
    setSmsState("sending");
    try {
      setSmsState((await onSendSms()) ? "sent" : "error");
    } catch {
      setSmsState("error");
    }
  }

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      size="sm"
      title={t.title}
      description={t.desc(amount)}
    >
      <div className="flex flex-col items-center gap-4 py-2">
        {url ? (
          <div className="rounded-xl bg-white p-3">
            <QRCodeSVG value={url} size={184} bgColor="#ffffff" fgColor="#0b0c10" level="M" />
          </div>
        ) : null}

        <div className="text-center text-2xl font-semibold text-nq-foreground">{amount}</div>

        {onSendSms ? (
          <div className="flex w-full flex-col items-center gap-1">
            <Button
              type="button"
              variant="primary"
              loading={smsState === "sending"}
              disabled={smsState === "sent"}
              data-testid="deposit-send-sms"
              className="w-full"
              onClick={() => void textLink()}
            >
              {smsState === "sending" ? t.sending : smsState === "sent" ? t.sent : t.sendSms}
            </Button>
            {smsState === "error" ? (
              <p className="text-xs font-semibold text-nq-error" role="status">
                {t.smsError}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex w-full items-center gap-2">
          <input
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 truncate rounded-lg border border-nq-muted/30 bg-nq-surface px-3 py-2 text-sm text-nq-foreground"
          />
          <Button type="button" variant="secondary" onClick={() => void copy()}>
            {copied ? t.copied : t.copy}
          </Button>
        </div>

        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-nq-accent underline underline-offset-2"
        >
          {t.openSquare}
        </a>
      </div>
    </Modal>
  );
}
