"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import {
  type ReturningCustomer,
} from "@/components/booking/useBookingFlowState";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import CountryPhoneField from "@/components/booking/CountryPhoneField";
import type { BookingComboItem, BookingServiceItem } from "@/shared/booking/catalog";
import type { ServiceCategorySummary } from "@/shared/booking/loadServiceCategories";
import type {
  BookingSalonMeta,
  BookingStaffItem,
} from "@/shared/booking/loadBookingServices";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { BookingFlow } from "@/components/booking/BookingFlow";
import { BookingGroupFlow } from "@/components/booking/BookingGroupFlow";
import { VoiceBookingButton } from "@/components/booking/VoiceBookingButton";
import { cn } from "@/shared/lib/cn";
import { GROUP_MAX_SIZE } from "@/shared/config/constants";
import { MAX_WAVES } from "@/shared/booking/groupSchedulerCore";

/**
 * Dynamic capacity: the effective group-size cap is whichever is
 * smaller — the salon's active-staff count, or the absolute safety
 * ceiling in `GROUP_MAX_SIZE` (20). This means a 10-staff salon
 * allows 10-person groups; a 3-staff salon is limited to 3.
 * A salon with only 1 active staff can't host a group booking, so
 * the toggle vanishes entirely below MIN_GROUP_SIZE.
 */
const MIN_GROUP_SIZE = 2;

// Compact OTP widget rendered INSIDE the phone gate card so the "Send code"
// button is always visible without scrolling. Handles SMS + email fallback.
function GateOtpInline({
  t,
  shopSlug,
  phoneDigits,
  emailLinksEnabled,
  onVerified,
}: {
  t: BookingMessages;
  shopSlug: string;
  phoneDigits: string;
  emailLinksEnabled?: boolean | null;
  onVerified: (sessionId: string) => void;
}) {
  const [stage, setStage] = useState<"idle" | "sent">("idle");
  const [channel, setChannel] = useState<"sms" | "email">("sms");
  const [email, setEmail] = useState("");
  const [showEmailInput, setShowEmailInput] = useState(false);
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  async function sendCode(ch: "sms" | "email" = channel) {
    setSending(true);
    setError(null);
    try {
      const body: Record<string, string> = { shopSlug, phone: phoneDigits, channel: ch };
      if (ch === "email") body.email = email.trim();
      const r = await fetch("/api/booking-otp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await r.json()) as { ok?: boolean; error?: string };
      if (data.ok) {
        setChannel(ch);
        setStage("sent");
        setTimeout(() => codeRef.current?.focus(), 100);
      } else {
        setError(
          data.error === "rate_limited"
            ? (t.bookingErrors.otpExpired ?? "Too many attempts.")
            : (t.bookingErrors.otpSendFailed ?? "Couldn't send code."),
        );
      }
    } catch {
      setError(t.bookingErrors.otpSendFailed ?? "Couldn't send code.");
    } finally {
      setSending(false);
    }
  }

  async function verifyCode(c = code) {
    const trimmed = c.replace(/\D/g, "");
    if (trimmed.length < 6) return;
    setVerifying(true);
    setError(null);
    try {
      const body: Record<string, string> = { shopSlug, phone: phoneDigits, code: trimmed };
      if (channel === "email") body.email = email.trim();
      const r = await fetch("/api/booking-otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await r.json()) as { ok?: boolean; sessionId?: string; error?: string };
      if (data.ok && data.sessionId) {
        onVerified(data.sessionId);
      } else {
        setError(
          data.error === "expired_or_max_attempts"
            ? (t.bookingErrors.otpExpired ?? "Code expired.")
            : (t.bookingErrors.otpInvalidCode ?? "Incorrect code."),
        );
      }
    } catch {
      setError(t.bookingErrors.otpInvalidCode ?? "Incorrect code.");
    } finally {
      setVerifying(false);
    }
  }

  function onCodeChange(v: string) {
    const d = v.replace(/\D/g, "").slice(0, 6);
    setCode(d);
    if (d.length === 6) void verifyCode(d);
  }

  if (stage === "idle") {
    return (
      <div className="mt-4 border-t border-[var(--booking-border)] pt-4">
        {showEmailInput && emailLinksEnabled ? (
          <div className="space-y-2">
            <input
              type="email"
              autoComplete="email"
              value={email}
              placeholder={t.otpEmailPlaceholder}
              onChange={(e) => setEmail(e.target.value)}
              className="nq-booking-field w-full"
            />
            <button
              type="button"
              disabled={sending || !email.includes("@")}
              onClick={() => void sendCode("email")}
              className="nq-booking-btn-primary w-full"
            >
              {sending ? t.otpEmailSending : t.otpEmailSendCta}
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={sending}
            onClick={() => void sendCode("sms")}
            className="nq-booking-btn-primary w-full"
          >
            {sending ? t.otpSending : t.otpSendCode}
          </button>
        )}
        {error ? <p className="mt-1.5 text-xs text-red-500">{error}</p> : null}
        {emailLinksEnabled && !showEmailInput ? (
          <button
            type="button"
            onClick={() => setShowEmailInput(true)}
            className="mt-2 block text-xs text-[var(--booking-text-muted)] underline"
          >
            {t.otpEmailFallbackCta}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-2 border-t border-[var(--booking-border)] pt-4">
      <p className="text-xs text-[var(--booking-text-muted)]">
        {t.otpStepSubheading} ···{phoneDigits.slice(-4)}
        {channel === "email" ? ` ${t.otpAndEmail ?? "& email"}` : ""}
      </p>
      <input
        ref={codeRef}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        placeholder={t.otpCodePlaceholder}
        onChange={(e) => onCodeChange(e.target.value)}
        className="nq-booking-field w-full text-center text-xl tracking-[0.4em] font-mono"
        aria-label={t.otpCodeLabel}
      />
      {error ? <p className="text-xs text-red-500">{error}</p> : null}
      <button
        type="button"
        disabled={verifying || code.length < 6}
        onClick={() => void verifyCode()}
        className="nq-booking-btn-primary w-full"
      >
        {verifying ? t.otpVerifying : t.otpVerify}
      </button>
      <button
        type="button"
        disabled={sending}
        onClick={() => { setCode(""); void sendCode(channel); }}
        className="block w-full text-center text-xs text-[var(--booking-text-muted)] underline"
      >
        {sending ? t.otpSending : t.otpResend}
      </button>

      {/* Email fallback — visible after SMS is sent so customers who don't
          receive the text can switch channels without starting over. */}
      {emailLinksEnabled && channel === "sms" ? (
        showEmailInput ? (
          <div className="space-y-2 pt-1">
            <input
              type="email"
              autoComplete="email"
              value={email}
              placeholder={t.otpEmailPlaceholder}
              onChange={(e) => setEmail(e.target.value)}
              className="nq-booking-field w-full"
            />
            <button
              type="button"
              disabled={sending || !email.includes("@")}
              onClick={() => { setCode(""); void sendCode("email"); }}
              className="nq-booking-btn-primary w-full"
            >
              {sending ? t.otpEmailSending : t.otpEmailSendCta}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowEmailInput(true)}
            className="block w-full text-center text-xs text-[var(--booking-text-muted)] underline"
          >
            {t.otpEmailFallbackCta}
          </button>
        )
      ) : null}
    </div>
  );
}

/**
 * Public booking entry-type selector — wraps both single-guest and
 * group flows so the customer can toggle between them on the
 * booking page. Default is `individual` so the existing UX is
 * unchanged for the 95% case.
 *
 * The toggle is intentionally a tiny two-button pill — no full
 * stepper for the choice itself, because going down the wrong path
 * is cheap to undo (just flip the pill back).
 */
export function BookingTypeSwitcher({
  t,
  shopSlug,
  services,
  addOns,
  combos,
  staff,
  salon,
  capabilityRows,
  categories,
  language = "en",
  voiceAiEnabled = false,
  groupBookingEnabled = true,
}: {
  t: BookingMessages;
  shopSlug: string;
  services: readonly BookingServiceItem[];
  addOns: readonly BookingServiceItem[];
  combos: readonly BookingComboItem[];
  staff: readonly BookingStaffItem[];
  salon: BookingSalonMeta;
  capabilityRows: { staff_id: string; service_id: string }[] | null;
  categories: readonly ServiceCategorySummary[];
  language?: "en" | "vi";
  voiceAiEnabled?: boolean;
  /** Release flag `group_booking` (PR2). When false, the Individual/Group
   *  toggle is not shown and only the individual flow renders. Defaults to
   *  `true` so callers that don't resolve the flag are unaffected. */
  groupBookingEnabled?: boolean;
}) {
  // P2.3 — initialize from ?mode= so language switch (which reloads
  // the page) doesn't drop the user back to individual.
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const initialMode: "individual" | "group" =
    searchParams.get("mode") === "group" ? "group" : "individual";
  const [mode, setMode] = useState<"individual" | "group">(initialMode);

  // Reflect mode changes back into the URL so language-toggle reloads
  // pick the same mode up via `searchParams.get("mode")`. Uses
  // `router.replace` so the history stack stays clean (the user
  // doesn't want a back-button trail for "individual → group").
  useEffect(() => {
    const current = new URLSearchParams(searchParams.toString());
    if (mode === "group") current.set("mode", "group");
    else current.delete("mode");
    const qs = current.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [mode, pathname, router, searchParams]);
  // QA round-2: active-staff-count drives group capacity. `staff` is
  // already pre-filtered to `status='active'` upstream in
  // `loadBookingServicesForSalonSlug`, so .length is the count.
  const activeStaffCount = staff.length;
  // Phase 6.1 — Wave Booking lets a group exceed the simultaneous staff count:
  // the scheduler splits it across up to MAX_WAVES sequential time waves. So the
  // selectable size is staffCount × MAX_WAVES (what waves can realistically
  // serve), bounded by the GROUP_MAX_SIZE (20) safety ceiling. A 0-staff salon
  // still can't take groups. Groups that fit at once behave exactly as before;
  // only larger groups (previously unselectable) now get the wave option.
  const maxGroupSize =
    activeStaffCount === 0
      ? 0
      : Math.min(activeStaffCount * MAX_WAVES, GROUP_MAX_SIZE);
  // Group is available only when the salon has the capacity AND the
  // `group_booking` release flag is enabled (PR2 — Beta, default OFF).
  const groupEnabled = groupBookingEnabled && maxGroupSize >= MIN_GROUP_SIZE;

  // ── Phone-first gate ───────────────────────────────────────────
  // Ask the customer's phone once, up front, and recognise returning
  // guests BEFORE they pick Individual vs Group. The Individual/Group
  // choice + the flow only appear AFTER a valid phone is entered — so
  // the gate is the single phone input and the individual flow starts
  // at "service" (never showing its own phone step → never two inputs).
  const [entryPhoneRaw, setEntryPhoneRaw] = useState("");
  const [entryCustomer, setEntryCustomer] = useState<ReturningCustomer | null>(
    null,
  );
  const [entryLoading, setEntryLoading] = useState(false);
  // New-customer name captured at the gate (when the phone isn't
  // recognized) so identity (phone + name) is collected once, up front.
  const [entryName, setEntryName] = useState("");
  // SMS consent (CASL/TCPA) — collected at the gate, right after the phone
  // (where the OTP SMS gets sent). The flow only reveals after it's given, and
  // it's passed into BookingFlow so confirm doesn't ask again.
  const [entrySmsConsent, setEntrySmsConsent] = useState(false);
  // Option B — gate-first OTP: verify phone before entering the flow so the
  // OTP step inside the flow is skipped (no re-prompt, no re-SMS).
  const [gateOtpDone, setGateOtpDone] = useState(false);
  const [gateOtpSessionId, setGateOtpSessionId] = useState<string | null>(null);
  // Ref prevents the anonymous lookup callback from overwriting the full profile
  // fetched after OTP verification.
  const gateOtpVerifiedRef = useRef(false);
  const entryLookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const entryValidation = validateGuestPhone(entryPhoneRaw.trim());
  const entryPhone = entryValidation.ok ? entryPhoneRaw.trim() : "";
  // Returning customers (phone recognized) skip name entry — their name comes
  // from the verified profile after OTP. New customers must type ≥2 chars.
  // ≥2 matches the nameTooShort guard in submitPublicBooking.
  const nameOk = Boolean(entryCustomer) || entryName.trim().length >= 2;
  // Ready to enter the flow: valid phone + name + SMS consent.
  const gateReady = Boolean(entryPhone) && nameOk && entrySmsConsent;
  // Debounced commit of the typed name so the flow (keyed on identity)
  // doesn't remount on every keystroke — it picks the name up ~400ms
  // after typing stops, or immediately on blur (see the name input).
  const [committedName, setCommittedName] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setCommittedName(entryName), 400);
    return () => clearTimeout(id);
  }, [entryName]);

  // After gate OTP: entryCustomer.name holds the verified profile name (PII now
  // safe to display). Before OTP / for new customers: fall back to what they typed.
  const entryNameResolved =
    (entryCustomer?.name ?? "").trim() || committedName.trim();

  useEffect(() => {
    // Phone changed → reset gate OTP state so the new number must be re-verified.
    setGateOtpDone(false);
    setGateOtpSessionId(null);
    gateOtpVerifiedRef.current = false;

    if (entryLookupTimer.current) {
      clearTimeout(entryLookupTimer.current);
      entryLookupTimer.current = null;
    }
    const v = validateGuestPhone(entryPhoneRaw.trim());
    if (!v.ok) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reactive reset when phone becomes invalid
      setEntryCustomer(null);
      setEntryLoading(false);
      return;
    }
    setEntryLoading(true);
    entryLookupTimer.current = setTimeout(() => {
      void fetch(
        `/api/customer/${encodeURIComponent(v.digits)}?salon_id=${encodeURIComponent(salon.id)}`,
      )
        .then((r) => r.json() as Promise<ReturningCustomer | { found: false }>)
        .then((data) => {
          // Don't overwrite the full profile already fetched after OTP verification.
          if (gateOtpVerifiedRef.current) return;
          setEntryCustomer(data.found ? (data as ReturningCustomer) : null);
        })
        .catch(() => { if (!gateOtpVerifiedRef.current) setEntryCustomer(null); })
        .finally(() => setEntryLoading(false));
    }, 400);
    return () => {
      if (entryLookupTimer.current) clearTimeout(entryLookupTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryPhoneRaw, salon.id]);

  // Defensive fallback — older deployed booking i18n bundles (before
  // PR #140 / #141) may not have the `groupBooking` namespace; if a
  // cached client gets here without it the destructure would throw
  // inside the error boundary. Synthesize a minimal English default
  // so the toggle still renders and we don't blank-screen.
  const groupCopy = (t.groupBooking ?? {
    entryTitle: "How would you like to book?",
    individual: "Individual",
    group: "Group 👥",
  }) as NonNullable<BookingMessages["groupBooking"]>;

  // Solo-staff salon → no group booking, no toggle. Render only the
  // individual flow so the page reads exactly like the pre-group
  // experience for these salons.
  // Phone-first gate UI — shown above whichever flow renders. Recognises
  // returning guests before they choose. `key` on the flows below makes
  // them remount once a valid phone lands, so the captured phone +
  // customer pre-fill the flow (individual skips its phone step; group
  // pre-fills the primary contact).
  const phoneGate = (
    <div
      data-testid="booking-phone-gate"
      className="rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-4 sm:p-5"
    >
      <label
        htmlFor="booking-entry-phone"
        className="mb-1 block text-sm font-semibold"
      >
        {t.clientPhoneLabel}
      </label>
      <CountryPhoneField
        id="booking-entry-phone"
        testId="booking-entry-phone"
        value={entryPhoneRaw}
        onChange={setEntryPhoneRaw}
        salonTimezone={salon.timezone}
        language={language}
      />
      {entryCustomer ? (
        // Pre-OTP: generic warm recognition (no PII leak — privacy fix S1).
        // Post-OTP: profile name is known → personalized greeting.
        <p
          data-testid="booking-entry-recognized"
          className="mt-2 text-sm font-medium text-[var(--salon-primary)]"
        >
          {entryCustomer.name
            ? (groupCopy.entryNewGreeting ?? "Hi {name}! 👋").replace(
                "{name}",
                entryCustomer.name,
              )
            : `👋 ${t.returningCustomer.welcomeBack}`}
          {entryCustomer.isVip ? ` · ${groupCopy.organizerVip ?? "VIP"}` : ""}
          {typeof entryCustomer.visitCount === "number" && entryCustomer.visitCount > 0
            ? ` · ${entryCustomer.visitCount}×`
            : ""}
        </p>
      ) : (
        <p className="mt-1.5 text-xs text-[var(--booking-text-muted)]">
          {t.clientPhoneHint}
        </p>
      )}
      {entryLoading ? <span className="sr-only">…</span> : null}

      {/* Name input: shown for new customers and returning ones before OTP.
          After OTP verify the profile supplies the name → input hidden. */}
      {entryPhone && !entryLoading && !entryCustomer ? (
        <div className="mt-3">
          <label
            htmlFor="booking-entry-name"
            className="mb-1 block text-sm font-semibold"
          >
            {t.clientNameLabel}
          </label>
          <input
            id="booking-entry-name"
            type="text"
            autoComplete="name"
            data-testid="booking-entry-name"
            value={entryName}
            placeholder={t.clientNameLabel}
            maxLength={100}
            onChange={(e) => setEntryName(e.target.value)}
            onBlur={() => setCommittedName(entryName)}
            className="nq-booking-field"
          />
          {entryName.trim() ? (
            <p
              data-testid="booking-entry-newgreeting"
              className="mt-2 text-sm font-medium text-[var(--salon-primary)]"
            >
              {(groupCopy.entryNewGreeting ?? "Hi {name}! 👋").replace(
                "{name}",
                entryName.trim(),
              )}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* SMS consent (CASL/TCPA) — right after the phone, before the flow opens.
          Required to proceed (the OTP SMS is sent next). */}
      {entryPhone && !entryLoading ? (
        <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-xs leading-relaxed text-[var(--booking-text-muted)]">
          <input
            type="checkbox"
            data-testid="sms-consent"
            checked={entrySmsConsent}
            onChange={(e) => setEntrySmsConsent(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--salon-primary)]"
          />
          <span>{t.smsConsent}</span>
        </label>
      ) : null}

      {/* OTP inline — appears INSIDE the card so the "Send code" button is
          always visible without scrolling. Only when salon has OTP enabled. */}
      {gateReady && salon.phoneOtpEnabled && !gateOtpDone && entryValidation.ok ? (
        <GateOtpInline
          t={t}
          shopSlug={shopSlug}
          phoneDigits={entryValidation.digits}
          emailLinksEnabled={salon.emailLinksEnabled}
          onVerified={(sessionId) => { void handleGateOtpVerified(sessionId); }}
        />
      ) : gateOtpDone ? (
        <p className="mt-4 border-t border-[var(--booking-border)] pt-3 text-sm font-medium text-[var(--salon-primary)]">
          {t.otpVerified}
        </p>
      ) : null}
    </div>
  );

  // Fetches the full customer profile after gate OTP verification and updates
  // entryCustomer + entryName so the personalized greeting and flow pre-fills work.
  async function handleGateOtpVerified(sessionId: string) {
    setGateOtpSessionId(sessionId);
    setGateOtpDone(true);
    gateOtpVerifiedRef.current = true;

    const v = validateGuestPhone(entryPhoneRaw.trim());
    if (!v.ok) return;
    try {
      const r = await fetch(
        `/api/customer/profile-verified?otp_session_id=${encodeURIComponent(sessionId)}&phone=${encodeURIComponent(v.digits)}&salon_id=${encodeURIComponent(salon.id)}`,
      );
      if (!r.ok) return;
      const data = (await r.json()) as ReturningCustomer | { found: false };
      if (data.found) {
        setEntryCustomer(data as ReturningCustomer);
        const name = (data as ReturningCustomer).name?.trim();
        if (name && !entryName.trim()) {
          setEntryName(name);
          setCommittedName(name);
        }
      }
    } catch {
      // Non-fatal: flow opens without personalization on network error.
    }
  }

  // Shared props for BookingFlow — same in both individual-only and group-switcher paths.
  const flowReady = gateReady && (!salon.phoneOtpEnabled || gateOtpDone);
  const individualFlowProps = {
    t,
    shopSlug,
    services,
    addOns,
    combos,
    staff,
    salon,
    capabilityRows,
    categories,
    language,
    initialPhone: entryPhone,
    initialReturningCustomer: entryCustomer,
    initialName: entryNameResolved,
    initialSmsConsent: entrySmsConsent,
    initialOtpSessionId: gateOtpSessionId,
  } as const;

  if (!groupEnabled) {
    return (
      <div className="space-y-4">
        {voiceAiEnabled && (
          <VoiceBookingButton t={t} shopSlug={shopSlug} language={language} />
        )}
        {phoneGate}
        {flowReady ? (
          <BookingFlow
            key={`ind-${entryPhone}-${entryNameResolved}`}
            {...individualFlowProps}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-4" data-testid="booking-type-switcher-root">
      {voiceAiEnabled && (
        <VoiceBookingButton t={t} shopSlug={shopSlug} language={language} />
      )}
      {/* Phone-first: ask once, recognise, then choose. The choice +
          flow only appear AFTER a phone is entered — so the gate is the
          single phone input (the individual flow then starts at
          "service", skipping its own phone step → never two inputs). */}
      {phoneGate}
      {flowReady ? (
      <>
      <p
        id="booking-type-heading"
        className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--booking-text-muted)]"
      >
        {groupCopy.entryTitle}
      </p>
      <div
        role="tablist"
        aria-labelledby="booking-type-heading"
        aria-label={groupCopy.entryTitle}
        data-testid="booking-type-switcher"
        className="mt-2 flex w-full max-w-md rounded-full border border-[var(--booking-border)] bg-[var(--booking-bg-input)] p-1 text-sm font-semibold"
      >
        {(["individual", "group"] as const).map((m) => {
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`booking-type-${m}`}
              onClick={() => setMode(m)}
              className={cn(
                "flex-1 min-h-11 rounded-full px-4 py-2 transition-colors",
                active
                  ? "bg-[var(--salon-primary)] text-[var(--booking-bg)] shadow-sm"
                  : "text-[var(--booking-text)] hover:bg-[var(--booking-bg-card)]",
              )}
            >
              {m === "individual" ? groupCopy.individual : groupCopy.group}
            </button>
          );
        })}
      </div>

      {mode === "individual" ? (
        <BookingFlow
          key={`ind-${entryPhone}-${entryNameResolved}`}
          {...individualFlowProps}
        />
      ) : (
        <BookingGroupFlow
          key={`grp-${entryPhone}-${entryNameResolved}`}
          t={t}
          shopSlug={shopSlug}
          services={services}
          addOns={addOns}
          staff={staff}
          salon={salon}
          maxGroupSize={maxGroupSize}
          capabilityRows={capabilityRows}
          initialPhone={entryPhone}
          initialOrganizer={entryCustomer}
          initialName={entryNameResolved}
          initialSmsConsent={entrySmsConsent}
          language={language}
        />
      )}
      </>
      ) : null}
    </div>
  );
}
