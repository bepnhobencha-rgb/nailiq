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

// Module-level memory of the last SMS-OTP send per `${shopSlug}:${phone}`, so a
// remount of this panel (customer steps Back to the info step then Forward again
// before verifying) does NOT fire a second SMS while the first code is still
// valid. Survives component unmount within the same page session; the server
// cooldown is the cross-tab / cross-reload authority.
const lastSmsSentAt = new Map<string, number>();

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return phone;
  return "••• ••• " + digits.slice(-4);
}

function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return email;
  const head = user.slice(0, 1);
  return `${head}•••@${domain}`;
}

function isEmailish(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export function BookingFlowOtpPanel({
  t,
  shopSlug,
  clientPhone,
  clientEmail,
  emailChannelEnabled,
  stepDir,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- prop kept for API consistency with other BookingFlow panels; not needed by OTP panel
  reducedMotion: _reducedMotion,
  stepTransition,
  isOptional,
  onVerified,
  onSkip,
  onBack,
  salonPhone,
}: {
  t: BookingMessages;
  shopSlug: string;
  clientPhone: string;
  /** Email captured at the Info step (if any) — enables the email fallback. */
  clientEmail?: string;
  /** Salon's email-channel master (salons.email_links_enabled). */
  emailChannelEnabled?: boolean;
  /** Salon contact phone — shown as last-resort fallback when SMS and email both fail. */
  salonPhone?: string | null;
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
  const salonPhoneClean = salonPhone?.trim() || "";
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [sent, setSent] = useState(false);
  const [isSending, startSendTransition] = useTransition();
  const [isVerifying, startVerifyTransition] = useTransition();
  // Email fallback state. `emailUsed` is the address a code was emailed to — sent
  // alongside the verify request so the server also checks the email-code store.
  const onFileEmail = (clientEmail ?? "").trim();
  const canEmail = Boolean(emailChannelEnabled);
  const [emailUsed, setEmailUsed] = useState<string>("");
  const [showEmailInput, setShowEmailInput] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [isEmailing, startEmailTransition] = useTransition();
  const codeInputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Key for the per-phone "recently sent" guard. Digits-only so format variants
  // (spaces / +1) map to the same entry.
  const otpKey = `${shopSlug}:${clientPhone.replace(/\D/g, "")}`;

  function startCooldown(seconds: number = RESEND_COOLDOWN_S) {
    setCooldown(seconds);
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

  // Auto-send on mount: SMS always; ALSO email the code when an address is on
  // file (belt-and-suspenders — SMS link/code often filtered by US carriers, so
  // the email makes sure the code reaches the customer somewhere).
  useEffect(() => {
    void sendCode({ auto: true });
    if (canEmail && isEmailish(onFileEmail)) void sendEmailCode(onFileEmail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sendEmailCode(addr: string) {
    const email = addr.trim();
    if (!isEmailish(email)) return;
    startEmailTransition(async () => {
      try {
        const res = await fetch("/api/booking-otp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: clientPhone, shopSlug, channel: "email", email }),
        });
        const body = (await res.json()) as { ok?: boolean; error?: string };
        if (res.ok && body.ok) {
          setEmailUsed(email);
          setShowEmailInput(false);
        }
      } catch {
        /* email fallback is best-effort — SMS still works */
      }
    });
  }

  function sendCode(opts?: { auto?: boolean }) {
    setError(null);
    startSendTransition(async () => {
      // Auto-send on (re)mount: if we already texted this phone < cooldown ago
      // (customer stepped Back to edit info then Forward again), skip the
      // duplicate SMS — the prior code is still valid — and just restore the UI.
      // A manual resend click is never skipped here (server still throttles it).
      const last = lastSmsSentAt.get(otpKey) ?? 0;
      const elapsedS = Math.floor((Date.now() - last) / 1000);
      if (opts?.auto && last && elapsedS < RESEND_COOLDOWN_S) {
        setSent(true);
        startCooldown(RESEND_COOLDOWN_S - elapsedS);
        setTimeout(() => codeInputRef.current?.focus(), 100);
        return;
      }
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
        lastSmsSentAt.set(otpKey, Date.now());
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
          body: JSON.stringify({ phone: clientPhone, code: trimmed, shopSlug, email: emailUsed || undefined }),
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
          {emailUsed ? (
            <>
              {" "}
              {t.otpAndEmail}{" "}
              <span className="font-medium text-[var(--booking-text)]">
                {maskEmail(emailUsed)}
              </span>
            </>
          ) : null}
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
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
            onClick={() => sendCode()}
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

        {/* Email fallback — only when the salon's email channel is on. The happy
            path (SMS arrives) never needs this; it rescues a customer whose text
            never came (US carrier filtering) and captures a real email. */}
        {canEmail && sent ? (
          emailUsed ? (
            <p
              data-testid="otp-email-sent"
              className="text-xs text-[var(--booking-text-muted)]"
            >
              ✓ {t.otpEmailSent}{" "}
              <span className="font-medium text-[var(--booking-text)]">
                {maskEmail(emailUsed)}
              </span>
            </p>
          ) : showEmailInput ? (
            <div className="space-y-2">
              <label
                htmlFor="otp-email"
                className="block text-xs font-medium text-[var(--booking-text)]"
              >
                {t.otpEmailInputLabel}
              </label>
              <div className="flex gap-2">
                <input
                  id="otp-email"
                  data-testid="otp-email-input"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder={t.otpEmailPlaceholder}
                  className="min-w-0 flex-1 rounded-lg border border-[var(--booking-border)] bg-[var(--booking-bg-input)] px-3 py-2 text-sm text-[var(--booking-text)] placeholder:text-[var(--booking-text-muted)]/40 focus:outline-none focus:ring-2 focus:ring-[var(--salon-primary)]/60"
                />
                <button
                  type="button"
                  data-testid="otp-email-send"
                  disabled={isEmailing || !isEmailish(emailInput)}
                  onClick={() => sendEmailCode(emailInput)}
                  className="whitespace-nowrap rounded-lg bg-[var(--salon-primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {isEmailing ? t.otpEmailSending : t.otpEmailSendCta}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              data-testid="otp-email-fallback"
              onClick={() => {
                setShowEmailInput(true);
                setEmailInput(onFileEmail);
              }}
              className="flex w-full items-center gap-2 rounded-lg border border-[var(--booking-border)] bg-[var(--booking-bg-input)] px-3 py-2.5 text-left text-sm text-[var(--booking-text)] transition-colors hover:border-[var(--salon-primary)]/50"
            >
              <span className="text-base">📧</span>
              <span>{t.otpEmailFallbackCta}</span>
            </button>
          )
        ) : null}

        {/* Last-resort fallback: call the salon directly when both SMS and email fail */}
        {salonPhoneClean && sent ? (
          <div className="flex items-center justify-between rounded-lg border border-[var(--booking-border)] bg-[var(--booking-bg-input)] px-3 py-2.5">
            <span className="text-sm text-[var(--booking-text-muted)]">
              {t.otpCallSalonHint ?? "Still having trouble?"}
            </span>
            <a
              href={`tel:${salonPhoneClean}`}
              className="flex items-center gap-1.5 text-sm font-medium text-[var(--salon-primary)]"
            >
              <span>📞</span>
              <span>{t.otpCallSalonCta ?? "Call us to book"}</span>
            </a>
          </div>
        ) : null}

        <div className="flex gap-3">
          <Button
            type="button"
            variant="ghost"
            size="md"
            onClick={onBack}
            disabled={isVerifying}
            // Ghost paints text-nq-foreground (light, for the dark dashboard) —
            // washes out on the light booking theme. Force booking-theme text.
            className="flex-1 text-[var(--booking-text)] hover:bg-[var(--booking-bg-input)] hover:text-[var(--booking-text)]"
          >
            ← {t.back}
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
