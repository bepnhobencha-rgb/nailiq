"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { motion } from "@/shared/lib/motionClient";
import { Button } from "@/components/ui/Button";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import {
  bookingStepVariants,
  type BookingMotionDir,
} from "@/components/booking/bookingMotion";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { cn } from "@/shared/lib/cn";

const RESEND_COOLDOWN_S = 60;

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return phone;
  return "••• ••• " + digits.slice(-4);
}

export function BookingFlowOtpPanel({
  t,
  shopSlug,
  clientPhone,
  stepDir,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- prop kept for API consistency with other BookingFlow panels; not needed by OTP panel
  reducedMotion: _reducedMotion,
  stepTransition,
  isOptional,
  onVerified,
  onSkip,
  onBack,
}: {
  t: BookingMessages;
  shopSlug: string;
  clientPhone: string;
  stepDir: BookingMotionDir;
  reducedMotion: boolean;
  stepTransition: { duration: number; ease: [number, number, number, number] };
  /** When true, shows a "Skip" button — risk is medium, verification encouraged but not required. */
  isOptional?: boolean;
  onVerified: (sessionId: string) => void;
  /** Called when customer skips optional OTP — booking proceeds unverified. */
  onSkip?: () => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [sent, setSent] = useState(false);
  const [isSending, startSendTransition] = useTransition();
  const [isVerifying, startVerifyTransition] = useTransition();
  const codeInputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function startCooldown() {
    setCooldown(RESEND_COOLDOWN_S);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCooldown((s) => {
        if (s <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  // Auto-send on mount
  useEffect(() => {
    void sendCode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sendCode() {
    setError(null);
    startSendTransition(async () => {
      try {
        const res = await fetch("/api/booking-otp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: clientPhone, shopSlug }),
        });
        const body = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || !body.ok) {
          setError(t.bookingErrors.otpSendFailed);
          return;
        }
        setSent(true);
        startCooldown();
        setTimeout(() => codeInputRef.current?.focus(), 100);
      } catch {
        setError(t.bookingErrors.otpSendFailed);
      }
    });
  }

  function onVerify() {
    const trimmed = code.trim();
    if (!/^\d{4,8}$/.test(trimmed)) {
      setError(t.bookingErrors.otpInvalidCode);
      return;
    }
    setError(null);
    startVerifyTransition(async () => {
      try {
        const res = await fetch("/api/booking-otp/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: clientPhone, code: trimmed, shopSlug }),
        });
        const body = (await res.json()) as {
          ok?: boolean;
          sessionId?: string;
          error?: string;
        };
        if (!res.ok || !body.ok) {
          const errCode = body.error ?? "invalid_code";
          setError(
            errCode === "expired_or_max_attempts"
              ? t.bookingErrors.otpExpired
              : t.bookingErrors.otpInvalidCode,
          );
          return;
        }
        if (!body.sessionId) {
          setError(t.bookingErrors.otpSendFailed);
          return;
        }
        onVerified(body.sessionId);
      } catch {
        setError(t.bookingErrors.otpInvalidCode);
      }
    });
  }

  const resendLabel =
    cooldown > 0
      ? t.otpResendIn.replace("{s}", String(cooldown))
      : t.otpResend;

  return (
    <motion.div
      key="otp"
      custom={stepDir}
      variants={bookingStepVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={stepTransition}
      className="mt-6 w-full"
    >
      <h2 className="text-xl font-semibold text-[var(--booking-text)]">
        {t.otpStepHeading}
      </h2>
      {sent ? (
        <p className="mt-1 text-sm text-[var(--booking-text-muted)]">
          {t.otpStepSubheading}{" "}
          <span className="font-medium text-[var(--booking-text)]">
            {maskPhone(clientPhone)}
          </span>
        </p>
      ) : (
        <p className="mt-1 text-sm text-[var(--booking-text-muted)]">
          {isSending ? t.otpSending : t.otpSendCode + "…"}
        </p>
      )}

      <div className="mt-6 space-y-4">
        <div>
          <label
            htmlFor="otp-code"
            className="mb-2 block text-sm font-medium text-[var(--booking-text)]"
          >
            {t.otpCodeLabel}
          </label>
          <input
            ref={codeInputRef}
            id="otp-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, ""));
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isVerifying) onVerify();
            }}
            placeholder={t.otpCodePlaceholder}
            disabled={!sent || isVerifying}
            className={cn(
              "w-full rounded-xl border bg-[var(--booking-bg-input)] px-4 py-3 text-center text-xl tracking-widest text-[var(--booking-text)] placeholder:text-[var(--booking-text-muted)]/40 focus:outline-none focus:ring-2 focus:ring-[var(--salon-primary)]/60",
              error ? "border-nq-error/60" : "border-[var(--booking-border)]",
            )}
          />
          {error ? (
            <p role="alert" className="mt-1.5 text-xs text-nq-error">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            disabled={cooldown > 0 || isSending}
            onClick={sendCode}
            className="text-sm text-[var(--salon-primary)] underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSending ? t.otpSending : resendLabel}
          </button>
          {isOptional && onSkip ? (
            <button
              type="button"
              onClick={onSkip}
              className="text-sm text-[var(--booking-text-muted)] underline-offset-2 hover:underline"
            >
              {t.otpSkip ?? "Bỏ qua"}
            </button>
          ) : null}
        </div>
        {isOptional ? (
          <p className="text-xs text-[var(--booking-text-muted)]/70">
            {t.otpOptionalHint ?? "Xác thực OTP giúp giảm rủi ro không đến (không bắt buộc)"}
          </p>
        ) : null}

        {error ? null : null}

        <div className="flex gap-3">
          <Button
            type="button"
            variant="ghost"
            size="md"
            onClick={onBack}
            disabled={isVerifying}
            className="flex-1"
          >
            ← Back
          </Button>
          <LuxuryBookingCta
            disabled={!sent || isVerifying || code.trim().length < 4}
            onClick={onVerify}
            className="flex-[2]"
          >
            {isVerifying ? t.otpVerifying : t.otpVerify}
          </LuxuryBookingCta>
        </div>
      </div>
    </motion.div>
  );
}
