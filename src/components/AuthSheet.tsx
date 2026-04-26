"use client";

/**
 * components/AuthSheet.tsx
 *
 * Bottom sheet với 3 bước:
 *   step 1 → nhập số điện thoại
 *   step 2 → nhập OTP 6 ô
 *   step 3 → thành công
 *
 * Dùng:
 *   import { AuthSheet } from "@/components/AuthSheet";
 *   <AuthSheet open={open} onClose={() => setOpen(false)} />
 *
 * API routes cần tạo:
 *   POST /api/auth/send-otp   — body: { phone: string }
 *   POST /api/auth/verify-otp — body: { phone: string, code: string }
 */

import { useEffect, useRef, useState } from "react";

/* ─── Types ───────────────────────────────────────── */
type Step = "phone" | "otp" | "success";

interface AuthSheetProps {
  open: boolean;
  onClose: () => void;
  /** Gọi sau khi verify thành công */
  onSuccess?: (phone: string) => void;
}

/* ─── Main component ──────────────────────────────── */
export function AuthSheet({ open, onClose, onSuccess }: AuthSheetProps) {
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  /* Reset khi đóng */
  useEffect(() => {
    if (!open) {
      setTimeout(() => {
        setStep("phone");
        setPhone("");
        setError("");
      }, 400); // sau khi animation đóng xong
    }
  }, [open]);

  /* Khoá scroll body khi sheet mở */
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  /* ── Gửi OTP ── */
  async function handleSendOtp(formattedPhone: string) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: formattedPhone }),
      });
      if (!res.ok) throw new Error("Gửi mã thất bại. Thử lại nhé.");
      setPhone(formattedPhone);
      setStep("otp");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Có lỗi xảy ra");
    } finally {
      setLoading(false);
    }
  }

  /* ── Xác minh OTP ── */
  async function handleVerifyOtp(code: string) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code }),
      });
      if (!res.ok) throw new Error("Mã không đúng. Thử lại.");
      setStep("success");
      onSuccess?.(phone);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Mã không đúng");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        aria-hidden
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity duration-300 ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      {/* Sheet */}
      <div
        role="dialog"
        aria-modal
        aria-label="Đăng ký NailIQ"
        className={`fixed bottom-0 left-0 right-0 z-50 rounded-t-3xl bg-white pb-safe transition-transform duration-500 ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
        style={{ transitionTimingFunction: "cubic-bezier(.32,.72,0,1)" }}
      >
        {/* Drag handle */}
        <div className="flex justify-center pb-1 pt-3">
          <div className="h-1 w-10 rounded-full bg-neutral-200" />
        </div>

        {/* Step content */}
        <div className="px-6 pb-10 pt-2">
          {step === "phone" && (
            <PhoneStep
              onSubmit={handleSendOtp}
              loading={loading}
              error={error}
            />
          )}
          {step === "otp" && (
            <OtpStep
              phone={phone}
              onSubmit={handleVerifyOtp}
              onBack={() => setStep("phone")}
              onResend={() => handleSendOtp(phone)}
              loading={loading}
              error={error}
            />
          )}
          {step === "success" && (
            <SuccessStep phone={phone} onClose={onClose} />
          )}
        </div>
      </div>
    </>
  );
}

/* ─────────────────────────────────────────────────────
   Step 1 — Phone input
───────────────────────────────────────────────────── */

function PhoneStep({
  onSubmit,
  loading,
  error,
}: {
  onSubmit: (phone: string) => void;
  loading: boolean;
  error: string;
}) {
  const [raw, setRaw] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  /* Format US phone: (555) 000-0000 */
  function formatPhone(val: string) {
    const digits = val.replace(/\D/g, "").slice(0, 10);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setRaw(formatPhone(e.target.value));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 10) return;
    onSubmit(`+1${digits}`);
  }

  const digits = raw.replace(/\D/g, "");
  const isValid = digits.length === 10;

  return (
    <div>
      <h2 className="text-xl font-black tracking-tight text-neutral-900">
        Nhập số điện thoại
      </h2>
      <p className="mt-1 text-sm text-neutral-500">
        Mình sẽ gửi mã 6 số để xác nhận.
      </p>

      <form onSubmit={handleSubmit} className="mt-6">
        {/* Input row */}
        <div className={`flex h-14 items-center gap-0 rounded-2xl bg-neutral-100 px-4 ring-2 transition ${
          error ? "ring-red-300" : "ring-transparent focus-within:ring-neutral-300"
        }`}>
          {/* Country code */}
          <div className="flex shrink-0 items-center gap-1.5 border-r border-neutral-300 pr-3 text-sm font-semibold text-neutral-700">
            <span className="text-base">🇺🇸</span>
            <span>+1</span>
          </div>

          {/* Number field */}
          <input
            ref={inputRef}
            type="tel"
            inputMode="numeric"
            placeholder="(555) 000-0000"
            value={raw}
            onChange={handleChange}
            className="flex-1 bg-transparent pl-3 text-base font-medium text-neutral-900 placeholder:text-neutral-400 focus:outline-none"
          />
        </div>

        {error && (
          <p className="mt-2 text-sm font-medium text-red-600">{error}</p>
        )}

        <button
          type="submit"
          disabled={!isValid || loading}
          className="mt-4 flex w-full items-center justify-center rounded-full bg-neutral-900 py-4 text-base font-bold text-white transition disabled:opacity-40 active:scale-[0.98]"
        >
          {loading ? <Spinner /> : "Gửi mã →"}
        </button>
      </form>

      <p className="mt-4 text-center text-xs text-neutral-400">
        Bằng cách tiếp tục, bạn đồng ý với{" "}
        <a href="/terms" className="underline">Điều khoản</a> &amp;{" "}
        <a href="/privacy" className="underline">Chính sách bảo mật</a>.
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   Step 2 — OTP input (6 ô tự nhảy)
───────────────────────────────────────────────────── */

const OTP_LENGTH = 6;

function OtpStep({
  phone,
  onSubmit,
  onBack,
  onResend,
  loading,
  error,
}: {
  phone: string;
  onSubmit: (code: string) => void;
  onBack: () => void;
  onResend: () => void;
  loading: boolean;
  error: string;
}) {
  const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(""));
  const [resent, setResent] = useState(false);
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  /* Focus ô đầu tiên khi mount */
  useEffect(() => { refs.current[0]?.focus(); }, []);

  /* Auto-submit khi đủ 6 số */
  useEffect(() => {
    const code = digits.join("");
    if (code.length === OTP_LENGTH) onSubmit(code);
  }, [digits]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleChange(val: string, idx: number) {
    const digit = val.replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[idx] = digit;
    setDigits(next);
    if (digit && idx < OTP_LENGTH - 1) refs.current[idx + 1]?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent, idx: number) {
    if (e.key === "Backspace" && !digits[idx] && idx > 0) {
      refs.current[idx - 1]?.focus();
    }
  }

  /* Paste: phân phối 6 số vào từng ô */
  function handlePaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, OTP_LENGTH);
    const next = [...digits];
    pasted.split("").forEach((d, i) => { next[i] = d; });
    setDigits(next);
    refs.current[Math.min(pasted.length, OTP_LENGTH - 1)]?.focus();
  }

  async function handleResend() {
    setResent(false);
    await onResend();
    setResent(true);
    setTimeout(() => setResent(false), 3000);
  }

  const displayPhone = phone.replace("+1", "").replace(/(\d{3})(\d{3})(\d{4})/, "($1) $2-$3");
  const code = digits.join("");
  const isFull = code.length === OTP_LENGTH;

  return (
    <div>
      <button
        onClick={onBack}
        className="mb-4 text-sm font-medium text-neutral-400 transition hover:text-neutral-700"
      >
        ← Quay lại
      </button>

      <h2 className="text-xl font-black tracking-tight text-neutral-900">
        Kiểm tra tin nhắn
      </h2>
      <p className="mt-1 text-sm text-neutral-500">
        Mã 6 số đã gửi đến{" "}
        <span className="font-semibold text-neutral-700">+1 {displayPhone}</span>
      </p>

      {/* 6 OTP boxes */}
      <div
        className="mt-7 flex justify-between gap-2"
        onPaste={handlePaste}
      >
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => { refs.current[i] = el; }}
            type="tel"
            inputMode="numeric"
            maxLength={1}
            value={d}
            onChange={(e) => handleChange(e.target.value, i)}
            onKeyDown={(e) => handleKeyDown(e, i)}
            className={`h-14 w-full rounded-2xl border-2 text-center text-xl font-black text-neutral-900 transition focus:outline-none ${
              error
                ? "border-red-300 bg-red-50"
                : d
                ? "border-neutral-900 bg-white"
                : "border-neutral-200 bg-neutral-50 focus:border-neutral-400"
            }`}
          />
        ))}
      </div>

      {error && (
        <p className="mt-3 text-center text-sm font-medium text-red-600">{error}</p>
      )}

      {/* Resend */}
      <div className="mt-4 text-center text-sm text-neutral-400">
        Không nhận được?{" "}
        <button
          onClick={handleResend}
          className={`font-semibold transition ${
            resent ? "text-green-600" : "text-neutral-900 hover:underline"
          }`}
        >
          {resent ? "Đã gửi lại!" : "Gửi lại"}
        </button>
      </div>

      {/* Manual verify (nếu auto-submit bị miss) */}
      {isFull && (
        <button
          onClick={() => onSubmit(code)}
          disabled={loading}
          className="mt-5 flex w-full items-center justify-center rounded-full bg-neutral-900 py-4 text-base font-bold text-white transition disabled:opacity-40 active:scale-[0.98]"
        >
          {loading ? <Spinner /> : "Xác nhận →"}
        </button>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   Step 3 — Thành công
───────────────────────────────────────────────────── */

function SuccessStep({
  phone,
  onClose,
}: {
  phone: string;
  onClose: () => void;
}) {
  const slug = phone.replace(/\D/g, "").slice(-7); // demo slug

  return (
    <div className="py-4 text-center">
      {/* Check animation */}
      <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
        <svg
          width="28"
          height="28"
          viewBox="0 0 28 28"
          fill="none"
          className="animate-[checkDraw_.4s_ease-out_.1s_both]"
        >
          <path
            d="M6 14l6 6 10-11"
            stroke="#16a34a"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      <h2 className="text-2xl font-black tracking-tight text-neutral-900">
        Bạn đã vào! 🎉
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-neutral-500">
        Link đặt lịch của bạn đã sẵn sàng.
        <br />
        Khách có thể book 24/7 ngay bây giờ.
      </p>

      {/* Booking link preview */}
      <div className="mt-6 flex items-center gap-3 rounded-2xl bg-neutral-50 px-4 py-3 text-left">
        <p className="flex-1 truncate text-sm text-neutral-600">
          nailiq.com/<span className="font-semibold text-neutral-900">salon-{slug}</span>
        </p>
        <button
          onClick={() => navigator.clipboard?.writeText(`https://nailiq.com/salon-${slug}`)}
          className="shrink-0 rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-bold text-white"
        >
          Copy
        </button>
      </div>

      <button
        onClick={onClose}
        className="mt-4 w-full rounded-full bg-neutral-900 py-4 text-base font-bold text-white transition active:scale-[0.98]"
      >
        Vào dashboard →
      </button>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   Spinner
───────────────────────────────────────────────────── */

function Spinner() {
  return (
    <svg
      className="h-5 w-5 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}
