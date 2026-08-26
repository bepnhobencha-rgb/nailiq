"use client";

import { useEffect, useMemo, useState } from "react";

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
import { bookingSequenceDraftStorageKey } from "@/shared/booking/bookingSequenceDraft";

type EditableLine = {
  lineId: string;
  serviceId: string;
  staffPreference: "any" | string;
  addOnServiceIds: string[];
};
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function newId(): string {
  return crypto.randomUUID();
}

export function BookingSequenceFlow({
  services,
  addOns,
  staff,
  capabilityRows,
  salon,
  language,
  customer,
  otpSessionId,
  initialSmsConsent,
}: {
  services: readonly BookingServiceItem[];
  addOns: readonly BookingServiceItem[];
  staff: readonly BookingStaffItem[];
  capabilityRows: { staff_id: string; service_id: string }[] | null;
  salon: BookingSalonMeta;
  language: "en" | "vi";
  customer: { name: string; phone: string; email: string | null };
  otpSessionId: string | null;
  initialSmsConsent: boolean;
}) {
  const vi = language === "vi";
  const [lines, setLines] = useState<EditableLine[]>([
    { lineId: newId(), serviceId: "", staffPreference: "any", addOnServiceIds: [] },
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
  const [reconfirmRequired, setReconfirmRequired] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [healthAcknowledged, setHealthAcknowledged] = useState(false);
  const [stage, setStage] = useState<"build" | "review">("build");
  const [restored, setRestored] = useState(false);
  const [storageKey, setStorageKey] = useState<string | null>(null);

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
        saved.lines.every((line) =>
          typeof line.lineId === "string" && UUID_RE.test(line.lineId) &&
          services.some((service) => service.id === line.serviceId) &&
          (line.staffPreference === "any" || staff.some((person) => person.id === line.staffPreference)) &&
          Array.isArray(line.addOnServiceIds) &&
          line.addOnServiceIds.length <= 8 &&
          line.addOnServiceIds.every((id) => addOns.some((addOn) => addOn.id === id))
        ) &&
        typeof saved.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(saved.date) &&
        typeof saved.time === "string" && /^\d{2}:\d{2}$/.test(saved.time) &&
        typeof saved.sameStaffForAll === "boolean" &&
        (saved.voucherCode == null || (typeof saved.voucherCode === "string" && saved.voucherCode.length <= 32)) &&
        (saved.applyEmailDiscount == null || typeof saved.applyEmailDiscount === "boolean") &&
        typeof saved.requestId === "string" && UUID_RE.test(saved.requestId)
      ) {
        setLines(saved.lines);
        setDate(saved.date);
        setTime(saved.time);
        setSameStaffForAll(saved.sameStaffForAll);
        setVoucherCode(saved.voucherCode ?? "");
        setApplyEmailDiscount(saved.applyEmailDiscount === true);
        setRequestId(saved.requestId);
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

  function beginNewIntent() {
    setRequestId(newId());
    setQuote(null);
    setDone(false);
    setReconfirmRequired(false);
    setError(null);
    setStage("build");
  }

  function updateLine(index: number, patch: Partial<EditableLine>) {
    setLines((current) => current.map((line, position) =>
      position === index ? { ...line, ...patch } : line));
    beginNewIntent();
  }

  function intent() {
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
      })),
      sameStaffForAll,
      voucherCode: voucherCode.trim() || null,
      applyEmailDiscount: applyEmailDiscount && Boolean(customer.email),
      customer,
    };
  }

  async function fetchQuote() {
    const material = intent();
    if (!material) {
      setError(vi ? "Chọn đủ dịch vụ, ngày và giờ." : "Choose every service, date, and time.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/booking/sequence-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(material),
      });
      const result = await response.json() as {
        ok?: boolean;
        quote?: BookingSequenceQuote;
      };
      if (!response.ok || result.ok !== true || !result.quote) throw new Error("quote");
      setQuote(result.quote);
      setReconfirmRequired(false);
      setStage("review");
    } catch {
      setError(vi ? "Chưa thể kiểm tra chuỗi dịch vụ. Vui lòng thử lại." : "We could not verify this sequence. Please retry.");
    } finally {
      setBusy(false);
    }
  }

  async function createBooking() {
    const material = intent();
    if (
      !material ||
      !quote ||
      !acceptedTerms ||
      (salon.healthAckRequired === true && !healthAcknowledged)
    ) {
      setError(vi ? "Vui lòng xác nhận điều khoản bắt buộc." : "Please accept the required terms.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/booking/sequence-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: material,
          expectedPricingFingerprint: quote.pricingFingerprint,
          otpSessionId,
          healthAcknowledged,
          smsConsent: initialSmsConsent,
          language,
        }),
      });
      const result = await response.json() as {
        ok?: boolean;
        code?: string;
        quote?: BookingSequenceQuote;
      };
      if (result.code === "pricing_changed" && result.quote) {
        setQuote(result.quote);
        setReconfirmRequired(true);
        setError(vi ? "Giá hoặc lịch đã đổi. Vui lòng xem lại và bấm xác nhận lần nữa." : "Price or timing changed. Review it and confirm again.");
        return;
      }
      if (!response.ok || result.ok !== true) throw new Error("create");
      if (!result.quote) throw new Error("receipt");
      setQuote(result.quote);
      setDone(true);
      setReconfirmRequired(false);
      if (storageKey) sessionStorage.removeItem(storageKey);
    } catch {
      setError(vi ? "Chưa thể hoàn tất. Booking chưa được tạo thêm; vui lòng thử lại." : "We could not finish. No extra booking was created; please retry.");
    } finally {
      setBusy(false);
    }
  }

  if (done && quote) {
    return (
      <section data-testid="booking-sequence-done" className="rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-5">
        <h2 className="text-xl font-semibold">{vi ? "Đã đặt chuỗi dịch vụ" : "Sequence booked"}</h2>
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
              {index > 0 ? <p className="text-xs text-[var(--booking-text-muted)]">{vi ? "Khoảng chờ trước dịch vụ" : "Gap before service"}: {Math.max(0, Math.round((Date.parse(line.serviceStartUtc) - Date.parse(quote.lines[index - 1].serviceEndUtc)) / 60_000))} min</p> : null}
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
      </section>
    );
  }

  return (
    <section data-testid="booking-sequence-flow" className="space-y-4 rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-4 sm:p-5">
      <div>
        <h2 className="text-lg font-semibold">{vi ? "Chuỗi 1–5 dịch vụ" : "1–5 service sequence"}</h2>
        <p className="text-sm text-[var(--booking-text-muted)]">{vi ? "Chúng tôi kiểm tra nhân viên, thời gian chuẩn bị và giá cho toàn bộ chuỗi." : "We verify staff, prep time, and pricing for the whole sequence."}</p>
      </div>

      {lines.map((line, index) => (
        <div key={line.lineId} className="space-y-3 rounded-xl border border-[var(--booking-border)] p-3">
          <div className="flex items-center justify-between">
            <p className="font-semibold">{vi ? "Dịch vụ" : "Service"} {index + 1}</p>
            <div className="flex gap-3 text-sm">
              <button type="button" disabled={index === 0} onClick={() => { setLines((current) => { const next = [...current]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; }); beginNewIntent(); }} className="underline disabled:opacity-30">↑</button>
              <button type="button" disabled={index === lines.length - 1} onClick={() => { setLines((current) => { const next = [...current]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; return next; }); beginNewIntent(); }} className="underline disabled:opacity-30">↓</button>
              {lines.length > 1 ? (
                <button type="button" onClick={() => { setLines((current) => current.filter((_, i) => i !== index)); beginNewIntent(); }} className="underline">
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
        <button type="button" onClick={() => { setLines((current) => [...current, { lineId: newId(), serviceId: "", staffPreference: "any", addOnServiceIds: [] }]); beginNewIntent(); }} className="nq-booking-btn-ghost w-full">
          {vi ? "+ Thêm dịch vụ" : "+ Add service"}
        </button>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <input type="date" min={salonTodayYmd} value={date} onChange={(event) => { setDate(event.target.value); beginNewIntent(); }} className="nq-booking-field" />
        <input type="time" value={time} onChange={(event) => { setTime(event.target.value); beginNewIntent(); }} className="nq-booking-field" />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={sameStaffForAll} onChange={(event) => { setSameStaffForAll(event.target.checked); beginNewIntent(); }} />
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
      {customer.email ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={applyEmailDiscount} onChange={(event) => { setApplyEmailDiscount(event.target.checked); beginNewIntent(); }} />
          {vi ? "Áp dụng ưu đãi email nếu đủ điều kiện" : "Apply eligible email incentive"}
        </label>
      ) : null}
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
                {index > 0 ? <p className="text-xs text-[var(--booking-text-muted)]">{vi ? "Khoảng chờ" : "Gap"} {Math.max(0, Math.round((Date.parse(line.serviceStartUtc) - Date.parse(quote.lines[index - 1].serviceEndUtc)) / 60_000))} min</p> : null}
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
      {error ? <p role="alert" className="text-sm text-red-500">{error}</p> : null}
      {stage === "review" ? (
        <button type="button" onClick={() => { setStage("build"); setQuote(null); setReconfirmRequired(false); }} className="nq-booking-btn-ghost w-full">
          {vi ? "Quay lại chỉnh sửa" : "Back to edit"}
        </button>
      ) : null}
      {quote ? (
        <button type="button" disabled={busy || !acceptedTerms || (salon.healthAckRequired === true && !healthAcknowledged)} onClick={() => void createBooking()} className="nq-booking-btn-primary w-full">
          {busy ? "…" : reconfirmRequired ? (vi ? "Xác nhận giá mới" : "Confirm updated price") : (vi ? "Xác nhận đặt chuỗi" : "Confirm sequence")}
        </button>
      ) : (
        <button type="button" disabled={busy} onClick={() => void fetchQuote()} className="nq-booking-btn-primary w-full">
          {busy ? "…" : (vi ? "Kiểm tra chuỗi" : "Review sequence")}
        </button>
      )}
    </section>
  );
}
