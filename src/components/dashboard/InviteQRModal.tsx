"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { QRCodeSVG as QRCode } from "qrcode.react";
import { createInviteToken } from "@/shared/dashboard/inviteTokenActions";
import type { StaffAccessRole } from "@/shared/dashboard/staffAccess";

type Props = {
  slug: string;
  staffId: string;
  staffName: string;
  role: StaffAccessRole;
  isOpen: boolean;
  onClose: () => void;
};

export function InviteQRModal({ slug, staffId, staffName, role, isOpen, onClose }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();
  const generated = useRef(false);

  useEffect(() => {
    if (!isOpen || generated.current) return;
    generated.current = true;
    startTransition(async () => {
      const res = await createInviteToken(slug, staffId, role);
      if (res.ok) {
        setUrl(res.url);
        setExpiresAt(res.expiresAt);
      } else {
        setError(res.error);
      }
    });
  }, [isOpen, slug, staffId, role]);

  const handleCopy = async () => {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleClose = () => {
    generated.current = false;
    setUrl(null);
    setExpiresAt(null);
    setError(null);
    setCopied(false);
    onClose();
  };

  if (!isOpen) return null;

  const roleLabel = role === "admin" ? "Quản trị viên" : "Tiếp tân";
  const expireDate = expiresAt
    ? new Date(expiresAt).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" })
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#111214] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Link mời nhân viên</h2>
            <p className="mt-0.5 text-sm text-white/50">
              {staffName} · <span className="text-[#d4af37]">{roleLabel}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg p-1.5 text-white/40 transition hover:bg-white/10 hover:text-white"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Loading */}
        {pending && (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-[#d4af37] border-t-transparent" />
            <p className="text-sm text-white/50">Đang tạo QR…</p>
          </div>
        )}

        {/* Error */}
        {error && !pending && (
          <div className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* QR + link */}
        {url && !pending && (
          <>
            {/* QR code */}
            <div className="mb-5 flex justify-center">
              <div className="rounded-2xl bg-white p-4">
                <QRCode
                  value={url}
                  size={180}
                  level="M"
                  includeMargin={false}
                />
              </div>
            </div>

            {/* Instructions */}
            <div className="mb-4 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-center">
              <p className="text-sm font-medium text-white">
                📱 Nhân viên quét QR bằng điện thoại
              </p>
              <p className="mt-1 text-xs text-white/50">
                → đăng nhập Google → vào dashboard ngay
              </p>
            </div>

            {/* Or: copy link */}
            <div className="mb-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/40">
                Hoặc gửi link qua Zalo / iMessage
              </p>
              <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
                <span className="min-w-0 flex-1 truncate text-xs text-white/60">{url}</span>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="shrink-0 rounded-lg bg-[#d4af37] px-3 py-1.5 text-xs font-semibold text-[#0b0c10] transition hover:bg-[#c9a430]"
                >
                  {copied ? "✓ Đã copy" : "Copy"}
                </button>
              </div>
            </div>

            {/* Expiry */}
            {expireDate && (
              <p className="text-center text-xs text-white/30">
                Link dùng 1 lần · hết hạn {expireDate}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
