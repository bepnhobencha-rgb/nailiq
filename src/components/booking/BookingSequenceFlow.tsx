"use client";

import { BookingPhoneDiscountChoice } from "./BookingPhoneDiscountChoice";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { dispatchPendingBookingCreate, DEFINITE_CREATE_REJECTIONS, BookingCreateOutcomeUnknownError, BookingCreateRecoveryUnavailableError } from "@/shared/booking/pendingBookingCreate";

import {
  ConfirmStepCardCapture,
  type ConfirmStepCardHandle,
} from "@/components/booking/ConfirmStepCardCapture";
import { CapacityRescueOptIn } from "@/components/booking/CapacityRescueOptIn";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import type {
  BookingSalonMeta,
  BookingStaffItem,
} from "@/shared/booking/loadBookingServices";
import type {
  BookingSequenceQuote,
} from "@/shared/booking/bookingSequenceServer";
import { salonToday, salonWallTimeToUtcIso } from "@/shared/lib/salonTime";
import { formatCurrency } from "@/shared/lib/currencyFormat";
import { isBookingCreateRetired } from "@/shared/booking/retiredBookingCreate";
import { bookingSequenceDraftStorageKey } from "@/shared/booking/bookingSequenceDraft";
import { submitCapacityRescueRequest } from "@/shared/booking/submitCapacityRescueRequest";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import {
  resolveNoShowCardRequirement,
  type NoShowCardRequirement,
} from "@/shared/noshow/resolveNoShowCardRequirement";
import {
  resolveSavedNoShowCard,
  type SavedNoShowCard,
} from "@/shared/noshow/resolveSavedNoShowCard";

type EditableLine = {
  lineId: string;
  serviceId: string;
  staffPreference: "any" | string;
  addOnServiceIds: string[];
  timingPreference: "sequential" | "parallel";
};
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeEditableLineTiming(lines: EditableLine[]): EditableLine[] {
  return lines.map((line, index) => ({
    ...line,
    timingPreference:
      index === 1 && line.timingPreference === "parallel"
        ? "parallel"
        : "sequential",
  }));
}

function newId(): string {
  return crypto.randomUUID();
}

export function BookingSequenceFlow({
  t,
  services,
  addOns,
  staff,
  capabilityRows,
  salon,
  language,
  customer,
  otpSessionId: inheritedOtpSessionId,
  shopSlug = "",
  onOtpSessionInvalid,
  initialSmsConsent,
}: {
  t: BookingMessages;
  services: readonly BookingServiceItem[];
  addOns: readonly BookingServiceItem[];
  staff: readonly BookingStaffItem[];
  capabilityRows: { staff_id: string; service_id: string }[] | null;
  salon: BookingSalonMeta;
  language: "en" | "vi";
  customer: { name: string; phone: string; email: string | null };
  otpSessionId: string | null;
  shopSlug?: string;
  onOtpSessionInvalid?: () => void;
  initialSmsConsent: boolean;
}) {
  const [discountSession, setDiscountSession] = useState<{ phone: string; sessionId: string } | null>(null);
  const otpSessionId = discountSession?.phone === customer.phone ? discountSession.sessionId : inheritedOtpSessionId;
  const [discountVerifying, setDiscountVerifying] = useState(false);
  const [phoneVerificationRequired, setPhoneVerificationRequired] = useState(false);
  const vi = language === "vi";
  // Anonymous returning-customer lookup deliberately does not disclose a name.
  // Keep user-entered identity only in memory, scoped to this phone.
  const [enteredName, setEnteredName] = useState({ phone: customer.phone, name: "" });
  const customerName = customer.name.trim() ||
    (enteredName.phone === customer.phone ? enteredName.name.trim() : "");
  const [lines, setLines] = useState<EditableLine[]>([
    { lineId: newId(), serviceId: "", staffPreference: "any", addOnServiceIds: [], timingPreference: "sequential" },
  ]);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [sameStaffForAll, setSameStaffForAll] = useState(false);
  const [voucherCode, setVoucherCode] = useState("");
  const [applyEmailDiscount, setApplyEmailDiscount] = useState(false);
  const [requestId, setRequestId] = useState(newId);
  const [quote, setQuote] = useState<BookingSequenceQuote | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejectedOtpSessionId, setRejectedOtpSessionId] = useState<string | null | undefined>(undefined);
  const otpRecoveryRequired = rejectedOtpSessionId !== undefined &&
    (!otpSessionId || otpSessionId === rejectedOtpSessionId);
  const rateLimitMessage = vi ? "Bạn thao tác quá nhanh. Vui lòng chờ vài phút rồi kiểm tra lại lịch. Thông tin đã nhập vẫn được giữ." : "You are trying too quickly. Wait a few minutes, then check the appointment again. Your details are kept.";
  const [reconfirmRequired, setReconfirmRequired] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [healthAcknowledged, setHealthAcknowledged] = useState(false);
  const [stage, setStage] = useState<"build" | "review">("build");
  const [restored, setRestored] = useState(false);
  const [storageKey, setStorageKey] = useState<string | null>(null);
  const [fetchedCardRequirement, setFetchedCardRequirement] = useState<{
    key: string;
    requirement: NoShowCardRequirement | null;
  } | null>(null);
  const [fetchedSavedCard, setFetchedSavedCard] = useState<{
    key: string;
    card: SavedNoShowCard | null;
  } | null>(null);
  const [noShowConsent, setNoShowConsent] = useState(false);
  const [useDifferentCard, setUseDifferentCard] = useState(false);
  const [cardSourceId, setCardSourceId] = useState<string | null>(null);
  const [cardVerificationToken, setCardVerificationToken] = useState<string | null>(null);
  const [cardManagementPending, setCardManagementPending] = useState(false);
  const router = useRouter();
  const [capacityRescueEligible, setCapacityRescueEligible] = useState(false);
  const [capacityRescueJoined, setCapacityRescueJoined] = useState(false);
  const [capacityRescueSubmitting, setCapacityRescueSubmitting] = useState(false);
  const [capacityRescueError, setCapacityRescueError] = useState<string | null>(null);
  const cardRef = useRef<ConfirmStepCardHandle>(null);
  const createInFlightRef = useRef(false);

  useEffect(() => {
    let active = true;
    void (async () => {
    try {
      const identityStorageKey = await bookingSequenceDraftStorageKey({
        salonId: salon.id,
        phone: customer.phone,
      });
      if (!active) return;
      setStorageKey(identityStorageKey);
      const raw = sessionStorage.getItem(identityStorageKey);
      const saved = raw ? JSON.parse(raw) as {
        lines?: EditableLine[];
        date?: string;
        time?: string;
        sameStaffForAll?: boolean;
        voucherCode?: string;
        applyEmailDiscount?: boolean;
        requestId?: string;
      } : null;
      if (
        saved &&
        Array.isArray(saved.lines) &&
        saved.lines.length >= 1 &&
        saved.lines.length <= 5 &&
        saved.lines.every((line, index) =>
          typeof line.lineId === "string" && UUID_RE.test(line.lineId) &&
          services.some((service) => service.id === line.serviceId) &&
          (line.staffPreference === "any" || staff.some((person) => person.id === line.staffPreference)) &&
          Array.isArray(line.addOnServiceIds) &&
          line.addOnServiceIds.length <= 8 &&
          line.addOnServiceIds.every((id) => addOns.some((addOn) => addOn.id === id)) &&
          (line.timingPreference == null || line.timingPreference === "sequential" ||
            (line.timingPreference === "parallel" && index === 1))
        ) &&
        typeof saved.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(saved.date) &&
        typeof saved.time === "string" && /^\d{2}:\d{2}$/.test(saved.time) &&
        typeof saved.sameStaffForAll === "boolean" &&
        (saved.voucherCode == null || (typeof saved.voucherCode === "string" && saved.voucherCode.length <= 32)) &&
        (saved.applyEmailDiscount == null || typeof saved.applyEmailDiscount === "boolean") &&
        typeof saved.requestId === "string" && UUID_RE.test(saved.requestId)
      ) {
        setLines(saved.lines.map((line) => ({
          ...line,
          timingPreference: line.timingPreference ?? "sequential",
        })));
        setDate(saved.date);
        setTime(saved.time);
        setSameStaffForAll(saved.sameStaffForAll);
        setVoucherCode(saved.voucherCode ?? "");
        setApplyEmailDiscount(saved.applyEmailDiscount === true);
        setRequestId(isBookingCreateRetired(salon.id, saved.requestId) ? newId() : saved.requestId);
      }
    } catch {
      // Malformed local state is untrusted and ignored.
    } finally {
      if (active) setRestored(true);
    }
    })();
    return () => { active = false; };
  }, [addOns, customer.phone, salon.id, services, staff]);

  useEffect(() => {
    if (!restored || done || !storageKey) return;
    sessionStorage.setItem(storageKey, JSON.stringify({
      lines,
      date,
      time,
      sameStaffForAll,
      voucherCode,
      applyEmailDiscount,
      requestId,
    }));
  }, [applyEmailDiscount, date, done, lines, requestId, restored, sameStaffForAll, storageKey, time, voucherCode]);

  const requestedStartTimeUtc = useMemo(() => {
    if (!date || !/^\d{2}:\d{2}$/.test(time)) return null;
    const [hours, minutes] = time.split(":").map(Number);
    if (hours > 23 || minutes > 59) return null;
    try {
      return salonWallTimeToUtcIso(date, hours * 60 + minutes, salon.timezone);
    } catch {
      return null;
    }
  }, [date, salon.timezone, time]);
  const salonTodayYmd = useMemo(() => salonToday(salon.timezone), [salon.timezone]);

  const currentIntent = useMemo(() => {
    if (!requestedStartTimeUtc || lines.some((line) => !line.serviceId)) return null;
    return {
      salonId: salon.id,
      requestId,
      requestedStartTimeUtc,
      lines: lines.map((line, position) => ({
        lineId: line.lineId,
        position,
        serviceId: line.serviceId,
        staffPreference: line.staffPreference,
        preferredResourceId: null,
        addOnServiceIds: line.addOnServiceIds,
        timingPreference: line.timingPreference,
      })),
      sameStaffForAll,
      voucherCode: voucherCode.trim() || null,
      applyEmailDiscount: applyEmailDiscount && Boolean(customer.email),
      otpSessionId,
      customer: { ...customer, name: customerName },
    };
  }, [
    applyEmailDiscount,
    otpSessionId,
    customer,
    customerName,
    lines,
    requestId,
    requestedStartTimeUtc,
    salon.id,
    sameStaffForAll,
    voucherCode,
  ]);

  const cardRequirementKey = quote
    ? JSON.stringify([
        salon.id,
        quote.pricingFingerprint,
        customer.phone.replace(/\D/g, ""),
        quote.lines.map((line) => line.serviceId),
      ])
    : null;
  const cardRequirement =
    cardRequirementKey && fetchedCardRequirement?.key === cardRequirementKey
      ? fetchedCardRequirement.requirement
      : null;
  const cardRequirementLoading =
    cardRequirementKey !== null && fetchedCardRequirement?.key !== cardRequirementKey;

  useEffect(() => {
    if (!cardRequirementKey || !quote?.lines.length) return;
    if (!currentIntent) return;
    const requestKey = cardRequirementKey;
    let alive = true;
    void resolveNoShowCardRequirement({
      salonId: salon.id,
      serviceId: quote.lines[0].serviceId,
      sequenceIntent: currentIntent,
      sequencePricingFingerprint: quote.pricingFingerprint,
      clientPhone: customer.phone,
    })
      .then((requirement) => {
        if (alive) setFetchedCardRequirement({ key: requestKey, requirement });
      })
      .catch(() => {
        if (alive) setFetchedCardRequirement({ key: requestKey, requirement: null });
      });
    return () => { alive = false; };
  }, [cardRequirementKey, currentIntent, customer.phone, quote, salon.id]);

  const savedCardKey =
    cardRequirement?.required === true && otpSessionId
      ? JSON.stringify([salon.id, otpSessionId])
      : null;
  const savedCard =
    savedCardKey && fetchedSavedCard?.key === savedCardKey
      ? fetchedSavedCard.card
      : null;
  useEffect(() => {
    if (!savedCardKey || !otpSessionId) return;
    const requestKey = savedCardKey;
    let alive = true;
    void resolveSavedNoShowCard({ salonId: salon.id, otpSessionId })
      .then((card) => {
        if (alive) setFetchedSavedCard({ key: requestKey, card });
      })
      .catch(() => {
        if (alive) setFetchedSavedCard({ key: requestKey, card: null });
      });
    return () => { alive = false; };
  }, [otpSessionId, salon.id, savedCardKey]);

  const reuseSavedCard =
    cardRequirement?.required === true &&
    savedCard?.hasSavedCard === true &&
    !useDifferentCard;

  function beginNewIntent() {
    setRequestId(newId());
    setQuote(null);
    setDone(false);
    setReconfirmRequired(false);
    setError(null);
    setStage("build");
    setFetchedCardRequirement(null);
    setFetchedSavedCard(null);
    setNoShowConsent(false);
    setUseDifferentCard(false);
    setCardSourceId(null);
    setCardVerificationToken(null);
    setCardManagementPending(false);
    setCapacityRescueEligible(false);
    setCapacityRescueJoined(false);
    setCapacityRescueError(null);
    setPhoneVerificationRequired(false);
  }

  function updateLine(index: number, patch: Partial<EditableLine>) {
    setLines((current) => current.map((line, position) =>
      position === index ? { ...line, ...patch } : line));
    beginNewIntent();
  }

  async function fetchQuote() {
    if (otpRecoveryRequired || discountVerifying) return;
    if (customerName.length < 2) {
      setError(vi ? "Vui lòng nhập họ tên (ít nhất 2 ký tự)." : "Please enter your name (at least 2 characters).");
      return;
    }
    const material = currentIntent;
    if (!material) {
      setError(vi ? "Chọn đủ dịch vụ, ngày và giờ." : "Choose every service, date, and time.");
      return;
    }
    setBusy(true);
    setError(null);
    setCapacityRescueEligible(false);
    try {
      const response = await fetch("/api/booking/sequence-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(material),
      });
      const result = await response.json() as {
        ok?: boolean;
        code?: string;
        quote?: BookingSequenceQuote;
      };
      if (result.ok === false && result.code === "phone_verification_required") {
        setQuote(null);
        setPhoneVerificationRequired(true);
        setError(t.phoneOfferVerificationRequired);
        return;
      }
      if (!response.ok || result.ok !== true || !result.quote) {
        const parallelError = response.status === 429 && result.code === "rate_limited"
          ? "rate_limited"
          : result.code === "parallel_pair_not_allowed"
          ? (vi
              ? "Hai dịch vụ này chưa được salon xác nhận là có thể làm cùng lúc. Vui lòng chọn nối tiếp."
              : "The salon has not approved these services to run together. Choose sequential timing.")
          : result.code === "no_shared_parallel_resource"
            ? (vi
                ? "Hiện chưa có ghế/giường phù hợp để làm hai dịch vụ này cùng lúc. Hãy chọn nối tiếp hoặc giờ khác."
                : "No certified shared chair/bed is available for these services. Choose sequential timing or another time.")
            : result.code === "parallel_resource_unproven"
              ? (vi
                  ? "Salon chưa bật quản lý ghế/giường cho lịch song song. Vui lòng chọn nối tiếp."
                  : "The salon has not enabled chair/bed management for parallel services. Choose sequential timing.")
              : result.code === "parallel_requires_distinct_staff"
                ? (vi
                    ? "Làm cùng lúc cần hai nhân viên khác nhau."
                    : "Parallel services require two different staff members.")
                : result.code === "no_staff_available"
                  ? (vi ? "Chưa có đủ hai nhân viên vào giờ này." : "Two staff members are not available at this time.")
                  : result.code === "no_resource_available" || result.code === "slot_conflict"
                    ? (vi ? "Giờ này vừa hết chỗ. Vui lòng chọn giờ khác." : "This time just became unavailable. Choose another time.")
                    : null;
        if (parallelError) {
          setError(parallelError);
          setCapacityRescueEligible(
            result.code === "no_shared_parallel_resource" ||
              result.code === "no_staff_available" ||
              result.code === "no_resource_available" ||
              result.code === "slot_conflict",
          );
          return;
        }
        throw new Error("quote");
      }
      setQuote(result.quote);
      setReconfirmRequired(false);
      setStage("review");
    } catch {
      setError(vi ? "Chưa thể kiểm tra chuỗi dịch vụ. Vui lòng thử lại." : "We could not verify this sequence. Please retry.");
    } finally {
      setBusy(false);
    }
  }

  async function joinCapacityRescue(email: string) {
    if (!currentIntent || !date || lines.length < 1 || !lines[0].serviceId) {
      setCapacityRescueError(t.capacityRescueError);
      return;
    }
    setCapacityRescueSubmitting(true);
    setCapacityRescueError(null);
    try {
      const serviceIds = Array.from(new Set(lines.map((line) => line.serviceId)));
      await submitCapacityRescueRequest({
        salonId: salon.id,
        requestId,
        requestKind: "sequence",
        primaryServiceId: lines[0].serviceId,
        staffId: lines[0].staffPreference === "any" ? null : lines[0].staffPreference,
        bookingDateYmd: date,
        preferredSlotLabel: time || null,
        partySize: 1,
        clientName: customer.name,
        clientPhone: customer.phone,
        clientEmail: email,
        clientLocale: language,
        intent: {
          serviceIds,
          requestedStartTimeUtc: currentIntent.requestedStartTimeUtc,
          sameStaffForAll,
          lines: lines.map((line, position) => ({
            position,
            serviceId: line.serviceId,
            staffPreference: line.staffPreference,
            addOnServiceIds: line.addOnServiceIds,
            timingPreference: line.timingPreference,
          })),
        },
      });
      setCapacityRescueJoined(true);
    } catch {
      setCapacityRescueError(t.capacityRescueError);
    } finally {
      setCapacityRescueSubmitting(false);
    }
  }

  async function createBooking() {
    if (createInFlightRef.current || busy || done || otpRecoveryRequired || discountVerifying) return;
    const material = currentIntent;
    if (
      !material ||
      !quote ||
      !acceptedTerms ||
      cardRequirementLoading ||
      (cardRequirement?.required === true && !noShowConsent) ||
      (salon.healthAckRequired === true && !healthAcknowledged)
    ) {
      setError(vi ? "Vui lòng xác nhận điều khoản bắt buộc." : "Please accept the required terms.");
      return;
    }
    createInFlightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      let sourceId = cardSourceId;
      let verificationToken = cardVerificationToken;
      if (cardRequirement?.required === true && !reuseSavedCard && !sourceId) {
        cardRef.current?.clearError();
        const tokenized = await cardRef.current?.tokenize();
        if (!tokenized) return;
        sourceId = tokenized.token;
        verificationToken = tokenized.verificationToken ?? null;
        setCardSourceId(sourceId);
        setCardVerificationToken(verificationToken);
      }
      const { response, result } = await dispatchPendingBookingCreate({
        binding: { kind: "sequence", salonId: salon.id, idempotencyKey: material.requestId, pricingFingerprint: quote.pricingFingerprint },
        invoke: async signal => {
          const response = await fetch("/api/booking/sequence-create", {
            method: "POST", headers: { "Content-Type": "application/json" }, signal,
            body: JSON.stringify({
          intent: material,
          expectedPricingFingerprint: quote.pricingFingerprint,
          otpSessionId,
          healthAcknowledged,
          smsConsent: initialSmsConsent,
          language,
          cardSourceId: sourceId,
          cardVerificationToken: verificationToken,
          noShowConsent,
            }),
          });
          const result = await response.json() as {
            ok?: boolean; code?: string; bookingId?: string; quote?: BookingSequenceQuote;
            cardManagementPending?: boolean; cardManagementToken?: string | null; cardManagementRecoveryHref?: string | null;
          };
          return { response, result };
        },
        classify: ({ response, result }) => {
          if (response.status >= 400 && response.status < 500 && result.ok === false && DEFINITE_CREATE_REJECTIONS.has(result.code ?? "")) return "rejected";
          return response.ok && result.ok === true && typeof result.bookingId === "string" && UUID_RE.test(result.bookingId) &&
            result.quote?.requestId === material.requestId && result.quote.salonId === salon.id &&
            result.quote.pricingFingerprint === quote.pricingFingerprint && result.quote.lines.length === material.lines.length
            ? "succeeded" : "unknown";
        },
      });
      if (result.ok === false && result.code === "phone_verification_required") {
        // Definite rejection: retain draft/request ID, discard old quote and
        // card authority, then require a new quote and explicit confirmation.
        setQuote(null); setStage("build"); setPhoneVerificationRequired(true);
        setFetchedCardRequirement(null); setFetchedSavedCard(null); setNoShowConsent(false);
        setCardSourceId(null); setCardVerificationToken(null);
        setError(t.phoneOfferVerificationRequired);
        return;
      }
      if (
        response.status === 403 && result.ok === false &&
        (result.code === "otp_required" || result.code === "invalid_otp_session" || result.code === "otp_session_used")
      ) {
        // Only a definite pre-commit rejection can re-arm OTP. Keep the draft
        // and idempotency key, but discard everything authorized by the old
        // session/quote before allowing a fresh quote and card decision.
        setRejectedOtpSessionId(otpSessionId);
        setDiscountSession(null);
        setQuote(null);
        setStage("build");
        setReconfirmRequired(false);
        setFetchedCardRequirement(null);
        setFetchedSavedCard(null);
        setNoShowConsent(false);
        setUseDifferentCard(false);
        setCardSourceId(null);
        setCardVerificationToken(null);
        onOtpSessionInvalid?.();
        return;
      }
      if (result.code === "pricing_changed" && result.quote) {
        setQuote(result.quote);
        setFetchedCardRequirement(null);
        setFetchedSavedCard(null);
        setNoShowConsent(false);
        setCardSourceId(null);
        setCardVerificationToken(null);
        setReconfirmRequired(true);
        setError(vi ? "Giá hoặc lịch đã đổi. Vui lòng xem lại và bấm xác nhận lần nữa." : "Price or timing changed. Review it and confirm again.");
        return;
      }
      if (!response.ok && result.ok === false && result.code === "slot_conflict") {
        // A definite rejection permits a new intent; an unknown result must keep recovery authority.
        beginNewIntent();
        setError(vi
          ? "Giờ này vừa hết chỗ. Vui lòng chọn giờ khác hoặc nhân viên khác rồi kiểm tra lại."
          : "This time just became unavailable. Choose another time or staff member, then check again.");
        return;
      }
      if (response.status === 429 && result.ok === false && result.code === "rate_limited") {
        beginNewIntent();
        setError("rate_limited");
        return;
      }
      if (!response.ok || result.ok !== true) throw new Error("create");
      if (!result.quote) throw new Error("receipt");
      setQuote(result.quote);
      setCardManagementPending(result.cardManagementPending === true);
      if (result.cardManagementToken) router.replace(`/booking/save-card?token=${encodeURIComponent(result.cardManagementToken)}`);
      else if (result.cardManagementPending && result.cardManagementRecoveryHref) {
        router.replace(result.cardManagementRecoveryHref);
      }
      setDone(true);
      setReconfirmRequired(false);
      if (storageKey) sessionStorage.removeItem(storageKey);
      setCardSourceId(null);
      setCardVerificationToken(null);
    } catch (error) {
      setCardSourceId(null);
      setCardVerificationToken(null);
      if (error instanceof BookingCreateOutcomeUnknownError) {
        router.replace(error.recoveryHref);
      } else {
        setError(error instanceof BookingCreateRecoveryUnavailableError
          ? (vi ? "Chưa thể bắt đầu đặt lịch an toàn. Vui lòng tải lại trang và thử lại." : "We could not safely start your booking. Reload this page and try again.")
          : (vi ? "Chưa thể hoàn tất bước này. Vui lòng kiểm tra lại thông tin." : "We could not finish this step. Please review your information."));
      }
    } finally {
      createInFlightRef.current = false;
      setBusy(false);
    }
  }

  if (done && quote) {
    return (
      <section data-testid="booking-sequence-done" className="rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-5">
        <h2 className="text-xl font-semibold">{cardManagementPending ? t.cardProtection.reserved : vi ? "Đã đặt chuỗi dịch vụ" : "Sequence booked"}</h2>
        <ol className="mt-4 space-y-3">
          {quote.lines.map((line, index) => (
            <li key={line.lineId} className="rounded-xl bg-[var(--booking-bg-input)] p-3">
              <p className="font-semibold">{line.position + 1}. {line.serviceName}</p>
              <p className="text-sm text-[var(--booking-text-muted)]">{line.staffName}</p>
              <p className="text-sm text-[var(--booking-text-muted)]">
                {new Intl.DateTimeFormat(vi ? "vi-VN" : "en-CA", { timeZone: salon.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(line.serviceStartUtc))}
              </p>
              <p className="text-xs text-[var(--booking-text-muted)]">
                {vi ? "Chuẩn bị" : "Prep"}: {line.prepMinutes} min · {vi ? "Thời gian khách" : "Customer time"}: {line.durationMinutes} min · {vi ? "Đệm" : "Buffer"}: {line.bufferMinutes} min
              </p>
              {index > 0 ? (
                <p className="text-xs text-[var(--booking-text-muted)]">
                  {line.resolvedTimingMode === "parallel"
                    ? (vi ? "✓ Làm cùng lúc — 2 nhân viên" : "✓ At the same time — 2 staff")
                    : `${vi ? "Khoảng chờ trước dịch vụ" : "Gap before service"}: ${Math.max(0, Math.round((Date.parse(line.serviceStartUtc) - Date.parse(quote.lines[index - 1].serviceEndUtc)) / 60_000))} min`}
                </p>
              ) : null}
              {line.addonLines.map((addOn) => <p key={addOn.serviceId} className="text-xs">+ {addOn.name}: {formatCurrency(addOn.priceCents, quote.currency)}</p>)}
              {line.promoDiscountCents > 0 ? <p className="text-xs">− {vi ? "Khuyến mãi" : "Promotion"}: {formatCurrency(line.promoDiscountCents, quote.currency)}</p> : null}
              {line.emailDiscountCents > 0 ? <p className="text-xs">− {vi ? "Ưu đãi email" : "Email incentive"}: {formatCurrency(line.emailDiscountCents, quote.currency)}</p> : null}
              {line.voucherDiscountCents > 0 ? <p className="text-xs">− Voucher: {formatCurrency(line.voucherDiscountCents, quote.currency)}</p> : null}
              {line.taxBreakdown.map((tax) => <p key={`${tax.name}:${tax.rate}`} className="text-xs">+ {tax.name}: {formatCurrency(tax.amountCents, quote.currency)}</p>)}
              <p className="text-sm">{formatCurrency(line.totalCents, quote.currency)}</p>
            </li>
          ))}
        </ol>
        <div className="mt-4 space-y-1 border-t border-[var(--booking-border)] pt-3 text-sm">
          <p>{vi ? "Giá gốc" : "Original services"}: {formatCurrency(quote.originalPriceCents, quote.currency)}</p>
          {quote.promoDiscountCents > 0 ? <p>− {vi ? "Khuyến mãi" : "Promotion"}: {formatCurrency(quote.promoDiscountCents, quote.currency)}</p> : null}
          {quote.emailDiscountCents > 0 ? <p>− {vi ? "Ưu đãi email" : "Email incentive"}: {formatCurrency(quote.emailDiscountCents, quote.currency)}</p> : null}
          {quote.voucherDiscountCents > 0 ? <p>− Voucher: {formatCurrency(quote.voucherDiscountCents, quote.currency)}</p> : null}
          <p>{vi ? "Tạm tính" : "Subtotal"}: {formatCurrency(quote.subtotalCents, quote.currency)}</p>
          {quote.taxBreakdown.map((tax) => <p key={`${tax.name}:${tax.rate}`}>+ {tax.name}: {formatCurrency(tax.amountCents, quote.currency)}</p>)}
          <p className="font-semibold">{vi ? "Tổng cộng" : "Total"}: {formatCurrency(quote.totalCents, quote.currency)}</p>
        </div>
        {cardManagementPending ? (
          <p
            role="status"
            data-testid="booking-sequence-card-pending"
            className="mt-4 rounded-xl border border-[var(--booking-border)] bg-[var(--booking-bg-input)] p-3 text-sm text-[var(--booking-text-muted)]"
          >
            {t.cardManagementPendingNotice}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section data-testid="booking-sequence-flow" className="space-y-4 rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-4 sm:p-5">
      <div>
        <h2 className="text-lg font-semibold">{vi ? "Chuỗi 1–5 dịch vụ" : "1–5 service sequence"}</h2>
        <p className="text-sm text-[var(--booking-text-muted)]">{vi ? "Chúng tôi kiểm tra nhân viên, thời gian chuẩn bị và giá cho toàn bộ chuỗi." : "We verify staff, prep time, and pricing for the whole sequence."}</p>
      </div>

      {!customer.name.trim() ? (
        <label className="block space-y-2 text-sm font-medium">
          <span>{vi ? "Họ và tên" : "Full name"}</span>
          <input
            name="sequenceCustomerName"
            autoComplete="name"
            maxLength={120}
            value={enteredName.phone === customer.phone ? enteredName.name : ""}
            onChange={(event) => {
              setEnteredName({ phone: customer.phone, name: event.target.value });
              beginNewIntent();
            }}
            className="nq-booking-field w-full"
          />
        </label>
      ) : null}

      {lines.map((line, index) => (
        <div key={line.lineId} className="space-y-3 rounded-xl border border-[var(--booking-border)] p-3">
          <div className="flex items-center justify-between">
            <p className="font-semibold">{vi ? "Dịch vụ" : "Service"} {index + 1}</p>
            <div className="flex gap-3 text-sm">
              <button type="button" disabled={index === 0} onClick={() => { setLines((current) => { const next = [...current]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return normalizeEditableLineTiming(next); }); beginNewIntent(); }} className="underline disabled:opacity-30">↑</button>
              <button type="button" disabled={index === lines.length - 1} onClick={() => { setLines((current) => { const next = [...current]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; return normalizeEditableLineTiming(next); }); beginNewIntent(); }} className="underline disabled:opacity-30">↓</button>
              {lines.length > 1 ? (
                <button type="button" onClick={() => { setLines((current) => normalizeEditableLineTiming(current.filter((_, i) => i !== index))); beginNewIntent(); }} className="underline">
                  {vi ? "Xoá" : "Remove"}
                </button>
              ) : null}
            </div>
          </div>
          <select value={line.serviceId} onChange={(event) => updateLine(index, { serviceId: event.target.value, addOnServiceIds: [] })} className="nq-booking-field w-full">
            <option value="">{vi ? "Chọn dịch vụ" : "Choose a service"}</option>
            {services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
          </select>
          <select value={line.staffPreference} onChange={(event) => updateLine(index, { staffPreference: event.target.value })} className="nq-booking-field w-full">
            <option value="any">{vi ? "Bất kỳ nhân viên phù hợp" : "Any qualified staff"}</option>
            {staff.filter((person) =>
              !line.serviceId ||
              !capabilityRows ||
              capabilityRows.some((capability) =>
                capability.staff_id === person.id && capability.service_id === line.serviceId,
              )
            ).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select>
          {index > 0 ? (
            <label className="block text-sm">
              <span className="mb-1 block text-[var(--booking-text-muted)]">
                {vi ? "Cách bắt đầu dịch vụ này" : "How this service starts"}
              </span>
              <select
                value={line.timingPreference}
                onChange={(event) => {
                  const timingPreference = event.target.value === "parallel" ? "parallel" : "sequential";
                  updateLine(index, { timingPreference });
                  if (timingPreference === "parallel") setSameStaffForAll(false);
                }}
                className="nq-booking-field w-full"
              >
                <option value="sequential">{vi ? "Nối tiếp dịch vụ trước" : "After the previous service"}</option>
                <option value="parallel">{vi ? "Làm cùng lúc với dịch vụ trước" : "At the same time as the previous service"}</option>
              </select>
              {line.timingPreference === "parallel" ? (
                <span className="mt-1 block text-xs text-[var(--booking-text-muted)]">
                  {vi
                    ? "NailIQ chỉ xác nhận khi có 2 thợ và cặp dịch vụ/resource đã được salon cho phép."
                    : "NailIQ confirms only when two staff and a salon-approved service/resource pairing are available."}
                </span>
              ) : null}
            </label>
          ) : null}
          {addOns.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {addOns.map((addOn) => {
                const checked = line.addOnServiceIds.includes(addOn.id);
                return (
                  <label key={addOn.id} className="flex items-center gap-2 rounded-lg border border-[var(--booking-border)] px-2.5 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && line.addOnServiceIds.length >= 8}
                      onChange={() => updateLine(index, {
                        addOnServiceIds: checked
                          ? line.addOnServiceIds.filter((id) => id !== addOn.id)
                          : [...line.addOnServiceIds, addOn.id],
                      })}
                    />
                    {addOn.name}
                  </label>
                );
              })}
            </div>
          ) : null}
        </div>
      ))}

      {lines.length < 5 ? (
        <button type="button" onClick={() => { setLines((current) => [...current, { lineId: newId(), serviceId: "", staffPreference: "any", addOnServiceIds: [], timingPreference: "sequential" }]); beginNewIntent(); }} className="nq-booking-btn-ghost w-full">
          {vi ? "+ Thêm dịch vụ" : "+ Add service"}
        </button>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-sm" htmlFor="booking-sequence-date">
          <span className="mb-1 block text-[var(--booking-text-muted)]">
            {vi ? "Ngày bắt đầu" : "Start date"}
          </span>
          <input
            id="booking-sequence-date"
            type="date"
            min={salonTodayYmd}
            value={date}
            onChange={(event) => { setDate(event.target.value); beginNewIntent(); }}
            className="nq-booking-field w-full"
          />
        </label>
        <label className="block text-sm" htmlFor="booking-sequence-time">
          <span className="mb-1 block text-[var(--booking-text-muted)]">
            {vi ? "Giờ bắt đầu" : "Start time"}
          </span>
          <input
            id="booking-sequence-time"
            type="time"
            value={time}
            onChange={(event) => { setTime(event.target.value); beginNewIntent(); }}
            className="nq-booking-field w-full"
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={sameStaffForAll} disabled={lines.some((line) => line.timingPreference === "parallel")} onChange={(event) => { setSameStaffForAll(event.target.checked); beginNewIntent(); }} />
        {vi ? "Cùng một nhân viên cho mọi dịch vụ" : "Same staff for every service"}
      </label>
      <input
        type="text"
        value={voucherCode}
        maxLength={32}
        placeholder={vi ? "Mã voucher (không bắt buộc)" : "Voucher code (optional)"}
        onChange={(event) => { setVoucherCode(event.target.value); beginNewIntent(); }}
        className="nq-booking-field w-full"
      />
      <BookingPhoneDiscountChoice
        t={t} shopSlug={shopSlug} phone={customer.phone} salonPhone={salon.salonPhone}
        hasEmail={Boolean(customer.email)} requested={applyEmailDiscount} verifying={discountVerifying}
        verificationRequired={phoneVerificationRequired} disabled={busy || !shopSlug}
        onStart={() => { setDiscountVerifying(true); setQuote(null); setNoShowConsent(false); setCardSourceId(null); setCardVerificationToken(null); }}
        onVerified={(sessionId) => { setDiscountSession({ phone: customer.phone, sessionId }); setApplyEmailDiscount(Boolean(customer.email)); setDiscountVerifying(false); beginNewIntent(); }}
        onSkip={() => { setApplyEmailDiscount(false); setDiscountVerifying(false); if (phoneVerificationRequired) setVoucherCode(""); beginNewIntent(); }}
      />
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} />
        <span>{vi ? "Tôi đồng ý với chính sách đặt và huỷ lịch của salon." : "I agree to the salon's booking and cancellation policy."}</span>
      </label>
      {salon.healthAckRequired === true ? (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={healthAcknowledged} onChange={(event) => setHealthAcknowledged(event.target.checked)} />
          <span>{vi ? "Tôi đã cung cấp thông tin sức khoẻ liên quan trước dịch vụ." : "I have disclosed relevant health information before service."}</span>
        </label>
      ) : null}

      {quote ? (
        <div data-testid="booking-sequence-review" className="rounded-xl bg-[var(--booking-bg-input)] p-4">
          <ol className="space-y-2">
            {quote.lines.map((line, index) => (
              <li key={line.lineId} className="border-b border-[var(--booking-border)] pb-2 text-sm last:border-0">
                <div className="flex justify-between gap-3 font-medium"><span>{line.position + 1}. {line.serviceName} · {line.staffName}</span><span>{formatCurrency(line.totalCents, quote.currency)}</span></div>
                <p className="text-xs text-[var(--booking-text-muted)]">{new Intl.DateTimeFormat(vi ? "vi-VN" : "en-CA", { timeZone: salon.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(line.serviceStartUtc))}</p>
                <p className="text-xs text-[var(--booking-text-muted)]">{vi ? "Chuẩn bị" : "Prep"} {line.prepMinutes} min · {vi ? "Khách" : "Customer"} {line.durationMinutes} min · {vi ? "Đệm" : "Buffer"} {line.bufferMinutes} min</p>
                {index > 0 ? (
                  <p className="text-xs text-[var(--booking-text-muted)]">
                    {line.resolvedTimingMode === "parallel"
                      ? (vi ? "✓ Làm cùng lúc — 2 nhân viên" : "✓ At the same time — 2 staff")
                      : `${vi ? "Khoảng chờ" : "Gap"} ${Math.max(0, Math.round((Date.parse(line.serviceStartUtc) - Date.parse(quote.lines[index - 1].serviceEndUtc)) / 60_000))} min`}
                  </p>
                ) : null}
                {line.addonLines.map((addOn) => <p key={addOn.serviceId} className="text-xs">+ {addOn.name}: {formatCurrency(addOn.priceCents, quote.currency)}</p>)}
                {line.promoDiscountCents > 0 ? <p className="text-xs">− {vi ? "Khuyến mãi" : "Promotion"}: {formatCurrency(line.promoDiscountCents, quote.currency)}</p> : null}
                {line.emailDiscountCents > 0 ? <p className="text-xs">− {vi ? "Ưu đãi email" : "Email incentive"}: {formatCurrency(line.emailDiscountCents, quote.currency)}</p> : null}
                {line.voucherDiscountCents > 0 ? <p className="text-xs">− Voucher: {formatCurrency(line.voucherDiscountCents, quote.currency)}</p> : null}
                {line.taxBreakdown.map((tax) => <p key={`${tax.name}:${tax.rate}`} className="text-xs">+ {tax.name}: {formatCurrency(tax.amountCents, quote.currency)}</p>)}
              </li>
            ))}
          </ol>
          <div className="mt-3 space-y-1 border-t border-[var(--booking-border)] pt-3 text-sm">
            <p className="flex justify-between"><span>{vi ? "Giá gốc" : "Original services"}</span><span>{formatCurrency(quote.originalPriceCents, quote.currency)}</span></p>
            {quote.promoDiscountCents > 0 ? <p className="flex justify-between"><span>− {vi ? "Khuyến mãi" : "Promotion"}</span><span>{formatCurrency(quote.promoDiscountCents, quote.currency)}</span></p> : null}
            {quote.emailDiscountCents > 0 ? <p className="flex justify-between"><span>− {vi ? "Ưu đãi email" : "Email incentive"}</span><span>{formatCurrency(quote.emailDiscountCents, quote.currency)}</span></p> : null}
            {quote.voucherDiscountCents > 0 ? <p className="flex justify-between"><span>− Voucher</span><span>{formatCurrency(quote.voucherDiscountCents, quote.currency)}</span></p> : null}
            <p className="flex justify-between"><span>{vi ? "Tạm tính" : "Subtotal"}</span><span>{formatCurrency(quote.subtotalCents, quote.currency)}</span></p>
            {quote.taxBreakdown.map((tax) => <p key={`${tax.name}:${tax.rate}`} className="flex justify-between"><span>+ {tax.name}</span><span>{formatCurrency(tax.amountCents, quote.currency)}</span></p>)}
            <p className="flex justify-between font-semibold"><span>{vi ? "Tổng cộng" : "Total"}</span><span>{formatCurrency(quote.totalCents, quote.currency)}</span></p>
          </div>
        </div>
      ) : null}
      {cardRequirementLoading ? (
        <p role="status" className="text-sm text-[var(--booking-text-muted)]">
          {vi ? "Đang kiểm tra chính sách lưu thẻ…" : "Checking card-on-file policy…"}
        </p>
      ) : null}
      {quote && cardRequirement?.required === true ? (
        <div data-testid="booking-sequence-card-policy">
          {reuseSavedCard && savedCard?.hasSavedCard ? (
            <div className="rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-4">
              <p className="text-sm font-semibold text-[var(--booking-text)]">
                {t.noShowCardTitle ?? "Secure your appointment"}
              </p>
              <div className="mt-3 flex items-center gap-3 rounded-lg border border-[var(--booking-border)] bg-[var(--booking-bg-input)] px-3 py-3">
                <span aria-hidden>💳</span>
                <span className="text-sm font-medium text-[var(--booking-text)]">
                  {savedCard.brand || "Card"} •••• {savedCard.last4}
                </span>
              </div>
              <button
                type="button"
                onClick={() => { setUseDifferentCard(true); setCardSourceId(null); setCardVerificationToken(null); }}
                className="mt-2 text-xs font-semibold text-[var(--salon-primary)] underline"
              >
                {t.noShowUseDifferentCard ?? "Use a different card"}
              </button>
            </div>
          ) : (
            <>
              <ConfirmStepCardCapture
                ref={cardRef}
                confirmationKey={noShowConsent && acceptedTerms && currentIntent && !cardRequirementLoading &&
                  (salon.healthAckRequired !== true || healthAcknowledged)
                  ? JSON.stringify([currentIntent, quote.pricingFingerprint]) : null}
                applicationId={cardRequirement.applicationId}
                locationId={cardRequirement.locationId}
                environment={cardRequirement.environment}
                feeLabel={formatCurrency(cardRequirement.feeCents, quote.currency) ?? ""}
                customerName={customer.name}
                customerPhone={customer.phone}
                customerEmail={customer.email ?? ""}
                t={t}
              />
              {savedCard?.hasSavedCard ? (
                <button
                  type="button"
                  onClick={() => { setUseDifferentCard(false); setCardSourceId(null); setCardVerificationToken(null); }}
                  className="mt-2 text-xs font-semibold text-[var(--salon-primary)] underline"
                >
                  {t.noShowUseSavedCard ?? "Use my saved card instead"}
                </button>
              ) : null}
            </>
          )}
          <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-xs leading-relaxed text-[var(--booking-text-muted)]">
            <input
              type="checkbox"
              data-testid="booking-sequence-noshow-consent"
              checked={noShowConsent}
              onChange={(event) => setNoShowConsent(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--salon-primary)]"
            />
            <span>
              {(t.noShowConsent ??
                "I agree to the no-show policy and authorize this salon to charge {fee} to this card only if I don't show up.").replace(
                "{fee}",
                formatCurrency(cardRequirement.feeCents, quote.currency) ?? "",
              )}
            </span>
          </label>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-red-500">{error === "rate_limited" ? rateLimitMessage : error}</p> : null}
      {otpRecoveryRequired ? (
        <p role="alert" data-testid="booking-sequence-otp-recovery" className="text-sm text-[var(--booking-text-muted)]">
          {vi
            ? "Phiên xác thực đã hết hiệu lực. Vui lòng xác thực lại ở phía trên, sau đó kiểm tra lại lịch và giá. Thông tin đã nhập vẫn được giữ."
            : "Your verification is no longer valid. Verify again above, then review the appointment and price. Your details are kept."}
        </p>
      ) : null}
      {capacityRescueEligible && currentIntent && stage === "build" ? (
        <CapacityRescueOptIn
          t={t}
          initialEmail={customer.email ?? ""}
          joined={capacityRescueJoined}
          submitting={capacityRescueSubmitting}
          error={capacityRescueError}
          onSubmit={(email) => void joinCapacityRescue(email)}
        />
      ) : null}
      {stage === "review" ? (
        <button type="button" onClick={() => { setStage("build"); setQuote(null); setReconfirmRequired(false); }} className="nq-booking-btn-ghost w-full">
          {vi ? "Quay lại chỉnh sửa" : "Back to edit"}
        </button>
      ) : null}
      {quote ? (
        <button type="button" disabled={busy || discountVerifying || otpRecoveryRequired || cardRequirementLoading || !acceptedTerms || (cardRequirement?.required === true && !noShowConsent) || (salon.healthAckRequired === true && !healthAcknowledged)} onClick={() => void createBooking()} className="nq-booking-btn-primary w-full">
          {busy ? "…" : reconfirmRequired ? (vi ? "Xác nhận giá mới" : "Confirm updated price") : (vi ? "Xác nhận đặt chuỗi" : "Confirm sequence")}
        </button>
      ) : (
        <button type="button" disabled={busy || discountVerifying || otpRecoveryRequired} onClick={() => void fetchQuote()} className="nq-booking-btn-primary w-full">
          {busy ? "…" : (vi ? "Kiểm tra chuỗi" : "Review sequence")}
        </button>
      )}
    </section>
  );
}
