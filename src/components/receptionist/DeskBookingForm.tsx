"use client";

/**
 * Receptionist "New appointment" form — books a phone-in OR walk-up customer for
 * a chosen date/time from the desk. Mirrors the public booking inputs (returning
 * customer lookup, real availability grid, add-ons, "any available staff",
 * conflict-safe create) but in one compact desk panel.
 *
 * Two entry points share this form:
 *   1. The "New appointment" header button — opens blank (good for far-out / any-
 *      staff bookings the grid can't show yet).
 *   2. Clicking an empty cell on the staff timeline grid — opens PRE-FILLED with
 *      that staff + date + the clicked time, so the receptionist confirms in one
 *      tap instead of scrolling the grid to avoid a double-book.
 *
 * Slots are computed client-side via `getAvailableTimeSlots` (the duration
 * already includes any selected add-ons, so availability can never undercount
 * the block and overlap the next booking). The create goes through
 * `addDeskAppointment` (conflict-safe RPC) and fires the same confirmation.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  addDeskAppointment,
  getDeskBookingData,
} from "@/shared/dashboard/receptionistActions";
import { lookupClientByPhone } from "@/shared/dashboard/lookupClientByPhoneAction";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import {
  getAvailableTimeSlots,
  type TimeSlot,
} from "@/shared/booking/getAvailableTimeSlots";

type LoadData = Extract<
  Awaited<ReturnType<typeof getDeskBookingData>>,
  { ok: true }
>["data"];

type Props = {
  slug: string;
  salonId: string;
  /** Dashboard language — matches the rest of the receptionist center. */
  language: "en" | "vi";
  onClose: () => void;
  onCreated: () => void;
  /** Prefill (grid empty-slot click). Staff may be a UUID or the "any" sentinel. */
  initialServiceId?: string;
  initialStaffId?: string;
  initialYmd?: string;
  /** Desired time label, e.g. "2:00 PM" — auto-selected once it appears free. */
  initialSlotLabel?: string;
};

// Bilingual copy kept local to the form (UI labels, not config) so it stays
// in lockstep with the rest of the receptionist center's EN/VI toggle.
const COPY = {
  en: {
    heading: "New appointment",
    close: "Close",
    loadError: "Couldn't load data. Try again.",
    loading: "Loading…",
    phone: "Phone number *",
    name: "Customer name *",
    email: "Email (optional — for the confirmation)",
    service: "Service *",
    selectService: "— Select a service —",
    addons: "Add-ons (optional)",
    staff: "Staff *",
    anyStaff: "✨ Any available staff",
    selectStaff: "— Select staff —",
    selectServiceFirst: "Pick a service first",
    staffRequest: "❤️ Customer specifically asked for this tech",
    date: "Date *",
    time: "Time *",
    slotsLoading: "Finding open times…",
    noSlots: "No open times this day — pick another date.",
    notes: "Notes (optional)",
    submit: "Create appointment",
    submitting: "Creating…",
    submitError: "Couldn't create the appointment. Try again.",
    newCustomer: "New customer.",
    returning: (vip: string, visits: string) => `✨ Returning customer${vip}${visits} — info filled in.`,
    vipTag: " · VIP",
    visitsTag: (n: number) => ` · ${n} visits`,
    prefillHint: (time: string, staff: string) =>
      `${time}${staff ? ` · ${staff}` : ""} — pick a service to confirm.`,
    errors: {
      invalid_name: "Invalid name.",
      invalid_name_chars: "Name has invalid characters.",
      invalid_phone: "Invalid phone number.",
      invalid_email: "Invalid email.",
      invalid_service: "Please choose a service.",
      invalid_addon: "One of the add-ons is invalid.",
      invalid_staff: "Please choose a staff member.",
      no_staff_available: "No active staff can do this service.",
      invalid_date: "Please choose a date.",
      invalid_time: "Please choose a time.",
      time_slot_taken: "That time was just taken — pick another.",
      booking_limit_reached: "You've hit your plan's booking limit.",
      unauthorized: "You don't have permission to create bookings.",
    } as Record<string, string>,
  },
  vi: {
    heading: "Thêm hẹn mới",
    close: "Đóng",
    loadError: "Không tải được dữ liệu. Thử lại.",
    loading: "Đang tải…",
    phone: "Số điện thoại *",
    name: "Tên khách *",
    email: "Email (tuỳ chọn — để gửi xác nhận)",
    service: "Dịch vụ *",
    selectService: "— Chọn dịch vụ —",
    addons: "Dịch vụ kèm (tuỳ chọn)",
    staff: "Thợ *",
    anyStaff: "✨ Thợ nào cũng được",
    selectStaff: "— Chọn thợ —",
    selectServiceFirst: "Chọn dịch vụ trước",
    staffRequest: "❤️ Khách yêu cầu đúng thợ này",
    date: "Ngày *",
    time: "Giờ *",
    slotsLoading: "Đang tìm giờ trống…",
    noSlots: "Không còn giờ trống ngày này — chọn ngày khác.",
    notes: "Ghi chú (tuỳ chọn)",
    submit: "Tạo lịch hẹn",
    submitting: "Đang tạo lịch…",
    submitError: "Không tạo được lịch. Thử lại.",
    newCustomer: "Khách mới.",
    returning: (vip: string, visits: string) => `✨ Khách quen${vip}${visits} — đã điền sẵn.`,
    vipTag: " · VIP",
    visitsTag: (n: number) => ` · ${n} lần ghé`,
    prefillHint: (time: string, staff: string) =>
      `${time}${staff ? ` · ${staff}` : ""} — chọn dịch vụ để xác nhận.`,
    errors: {
      invalid_name: "Tên không hợp lệ.",
      invalid_name_chars: "Tên chứa ký tự không hợp lệ.",
      invalid_phone: "Số điện thoại không hợp lệ.",
      invalid_email: "Email không hợp lệ.",
      invalid_service: "Vui lòng chọn dịch vụ.",
      invalid_addon: "Một dịch vụ kèm không hợp lệ.",
      invalid_staff: "Vui lòng chọn thợ.",
      no_staff_available: "Không có thợ đang làm cho dịch vụ này.",
      invalid_date: "Vui lòng chọn ngày.",
      invalid_time: "Vui lòng chọn giờ.",
      time_slot_taken: "Giờ này vừa có người đặt — chọn giờ khác.",
      booking_limit_reached: "Đã đạt giới hạn lịch của gói hiện tại.",
      unauthorized: "Bạn không có quyền tạo lịch.",
    } as Record<string, string>,
  },
} as const;

function ymdToLocalNoon(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 12, 0, 0);
}

function todayYmd(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

export default function DeskBookingForm({
  slug,
  salonId,
  language,
  onClose,
  onCreated,
  initialServiceId,
  initialStaffId,
  initialYmd,
  initialSlotLabel,
}: Props) {
  const tx = COPY[language === "vi" ? "vi" : "en"];
  const [data, setData] = useState<LoadData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [serviceId, setServiceId] = useState(initialServiceId ?? "");
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [staffId, setStaffId] = useState(initialStaffId ?? "");
  const [staffRequested, setStaffRequested] = useState(false);
  // Default to today (not an empty "yyyy-mm-dd" placeholder) when not prefilled.
  const [ymd, setYmd] = useState(initialYmd ?? todayYmd());
  const [slotLabel, setSlotLabel] = useState("");
  const [notes, setNotes] = useState("");

  // Desired time from a grid click — auto-selected once it shows up free in the
  // freshly-computed slot grid (the grid cell is 30 min, the form grid 15 min,
  // and the real availability depends on the service the user picks here).
  const desiredSlotRef = useRef(initialSlotLabel ?? "");
  const prefilled = !!(initialStaffId || initialYmd || initialSlotLabel);

  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [lookupMsg, setLookupMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Portal target — the modal must escape the (transformed) Front-Desk header,
  // or `position: fixed` is trapped inside it.
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only mount flag for the portal
  useEffect(() => setMounted(true), []);

  // Load services / staff / salon meta once.
  useEffect(() => {
    let cancelled = false;
    void getDeskBookingData(slug).then((res) => {
      if (cancelled) return;
      if (res.ok) setData(res.data);
      else setLoadError(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Services this booking needs (main + add-ons) — used for capability filtering.
  const requiredServiceIds = useMemo(
    () => [serviceId, ...addonIds].filter(Boolean),
    [serviceId, addonIds],
  );

  // Staff capable of EVERY chosen service (capabilityRows null = all-capable).
  const capableStaff = useMemo(() => {
    if (!data) return [];
    if (!serviceId || !data.capabilityRows) return data.staff;
    const cap = new Map<string, Set<string>>();
    for (const r of data.capabilityRows) {
      let bucket = cap.get(r.staff_id);
      if (!bucket) {
        bucket = new Set();
        cap.set(r.staff_id, bucket);
      }
      bucket.add(r.service_id);
    }
    return data.staff.filter((s) => {
      const bucket = cap.get(s.id);
      return !!bucket && requiredServiceIds.every((id) => bucket.has(id));
    });
  }, [data, serviceId, requiredServiceIds]);

  // If the picked (specific) staff can't do the chosen service+add-ons, clear it.
  // "Any available" is never cleared — it isn't a concrete capability row.
  // Guard on `data` + `serviceId`: capability only matters once a service is
  // chosen, and capableStaff is [] until data loads — without this guard a
  // grid-prefilled staff would be wiped during the initial load window before
  // the receptionist ever sees it.
  useEffect(() => {
    if (!data || !serviceId) return;
    if (
      staffId &&
      staffId !== BOOKING_ANY_STAFF_ID &&
      !capableStaff.some((s) => s.id === staffId)
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reconcile staff to the new capability set
      setStaffId("");
    }
  }, [data, serviceId, capableStaff, staffId]);

  const service = useMemo(
    () => data?.services.find((s) => s.id === serviceId) ?? null,
    [data, serviceId],
  );

  // Total appointment block in minutes: main service + sequential add-ons.
  // Concurrent add-ons run alongside the main service and add no time. This is
  // what makes availability honest — a "gel + design" booking reserves the full
  // block so the next customer can't be slotted on top of it.
  const blockMinutes = useMemo(() => {
    if (!service) return 0;
    const extra = addonIds.reduce((sum, id) => {
      const a = data?.addOns.find((x) => x.id === id);
      if (!a) return sum;
      return sum + (a.addonConcurrent ? 0 : a.totalMinutes);
    }, 0);
    return service.totalMinutes + extra;
  }, [service, addonIds, data]);

  const closedDateYmdSet = useMemo(() => {
    const raw = data?.salon.booking_closed_dates;
    return new Set(Array.isArray(raw) ? (raw as string[]) : []);
  }, [data]);

  const shortestServiceMinutes = useMemo(
    () => (data ? Math.min(...data.services.map((s) => s.totalMinutes)) : 0),
    [data],
  );

  // Name of the prefilled staff (for the smart header). "" when "any" / blank.
  const prefillStaffName = useMemo(() => {
    if (!initialStaffId || initialStaffId === BOOKING_ANY_STAFF_ID) return "";
    return data?.staff.find((s) => s.id === initialStaffId)?.name ?? "";
  }, [data, initialStaffId]);

  // Compute the availability grid whenever service + staff + date are set.
  useEffect(() => {
    if (!data || !service || !staffId || !ymd || blockMinutes <= 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale grid when inputs incomplete
      setSlots([]);
      return;
    }
    let cancelled = false;
    setSlotsLoading(true);
    setSlotLabel("");
    void getAvailableTimeSlots({
      salonId,
      openingHoursRaw: data.salon.opening_hours,
      selectedDate: ymdToLocalNoon(ymd),
      staffId,
      staffList: capableStaff,
      serviceDurationMinutes: blockMinutes,
      closedDateYmdSet,
      shortestServiceMinutes,
      leadMinutes: data.salon.bookingLeadMinutes,
      timezone: data.salon.timezone,
    })
      .then((res) => {
        if (cancelled) return;
        setSlots(res);
        // Auto-select the time the receptionist clicked on the grid, once.
        const want = desiredSlotRef.current;
        if (want) {
          const match = res.find((s) => s.available && s.label === want);
          if (match) setSlotLabel(match.label);
          desiredSlotRef.current = "";
        }
      })
      .finally(() => {
        if (!cancelled) setSlotsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [data, service, staffId, ymd, salonId, capableStaff, closedDateYmdSet, shortestServiceMinutes, blockMinutes]);

  // Returning-customer recognition (debounced).
  const lookupSeq = useRef(0);
  useEffect(() => {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 8) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear hint when phone too short to look up
      setLookupMsg(null);
      return;
    }
    const seq = ++lookupSeq.current;
    const t = setTimeout(async () => {
      const res = await lookupClientByPhone(slug, phone);
      if (seq !== lookupSeq.current) return;
      if (res.ok && res.found) {
        const p = res.profile;
        if (p.name && !name) setName(p.name);
        if (p.email && !email) setEmail(p.email);
        if (p.top_service && !serviceId) setServiceId(p.top_service.id);
        if (p.top_staff && !staffId) setStaffId(p.top_staff.id);
        setLookupMsg(
          tx.returning(
            p.is_vip ? tx.vipTag : "",
            p.visit_count ? tx.visitsTag(p.visit_count) : "",
          ),
        );
      } else {
        setLookupMsg(tx.newCustomer);
      }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- name/email/serviceId/staffId read as "fill only when empty"; re-running on their change would loop
  }, [phone, slug]);

  const toggleAddon = useCallback((id: string) => {
    setAddonIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const canSubmit =
    !!name.trim() &&
    phone.replace(/\D/g, "").length >= 10 &&
    !!serviceId &&
    !!staffId &&
    !!ymd &&
    !!slotLabel &&
    !submitting;

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const res = await addDeskAppointment(slug, {
      salonId,
      serviceId,
      addonServiceIds: addonIds,
      staffId,
      staffRequestedByClient: staffId !== BOOKING_ANY_STAFF_ID && staffRequested,
      bookingDateYmd: ymd,
      timeSlot: slotLabel,
      clientName: name.trim(),
      clientPhone: phone.trim(),
      clientEmail: email.trim() || null,
      clientNotes: notes.trim() || null,
      language,
    });
    setSubmitting(false);
    if (res.ok) {
      onCreated();
      onClose();
    } else {
      setError(tx.errors[res.error] ?? tx.submitError);
    }
  }, [canSubmit, slug, salonId, serviceId, addonIds, staffId, staffRequested, ymd, slotLabel, name, phone, email, notes, language, onCreated, onClose, tx]);

  const inputCls =
    "w-full rounded-md border border-nq-muted/30 bg-nq-bg px-3 py-2 text-sm text-nq-foreground outline-none focus:border-nq-primary/60";
  const labelCls = "mb-1 block text-xs font-medium text-nq-muted";

  if (!mounted) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-nq-muted/25 bg-nq-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-base font-semibold text-nq-foreground">{tx.heading}</h2>
          <button onClick={onClose} className="text-nq-muted hover:text-nq-foreground" aria-label={tx.close}>
            ✕
          </button>
        </div>
        {prefilled && initialSlotLabel && !slotLabel ? (
          <p className="mb-3 text-xs font-medium text-nq-primary">
            {tx.prefillHint(initialSlotLabel, prefillStaffName)}
          </p>
        ) : (
          <div className="mb-3" />
        )}

        {loadError ? (
          <p className="text-sm text-nq-error">{tx.loadError}</p>
        ) : !data ? (
          <p className="text-sm text-nq-muted">{tx.loading}</p>
        ) : (
          <div className="space-y-3">
            <div>
              <label className={labelCls}>{tx.phone}</label>
              <input
                className={inputCls}
                inputMode="tel"
                placeholder="+1 (604) 555-1234"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
              {lookupMsg ? <p className="mt-1 text-[11px] text-nq-muted">{lookupMsg}</p> : null}
            </div>

            <div>
              <label className={labelCls}>{tx.name}</label>
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div>
              <label className={labelCls}>{tx.email}</label>
              <input
                className={inputCls}
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div>
              <label className={labelCls}>{tx.service}</label>
              <select
                className={inputCls}
                value={serviceId}
                onChange={(e) => setServiceId(e.target.value)}
              >
                <option value="">{tx.selectService}</option>
                {data.services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.priceDisplay ? ` · ${s.priceDisplay}` : ""}
                  </option>
                ))}
              </select>
            </div>

            {serviceId && data.addOns.length > 0 ? (
              <div>
                <label className={labelCls}>{tx.addons}</label>
                <div className="flex flex-wrap gap-1.5">
                  {data.addOns.map((a) => {
                    const on = addonIds.includes(a.id);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => toggleAddon(a.id)}
                        className={`rounded-full border px-2.5 py-1 text-xs transition ${
                          on
                            ? "border-nq-primary bg-nq-primary text-white"
                            : "border-nq-muted/30 bg-nq-bg text-nq-foreground hover:border-nq-primary/50"
                        }`}
                      >
                        {on ? "✓ " : "+ "}
                        {a.name}
                        {a.priceDisplay ? ` · ${a.priceDisplay}` : ""}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div>
              <label className={labelCls}>{tx.staff}</label>
              <select
                className={inputCls}
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
                disabled={!serviceId}
              >
                <option value="">{serviceId ? tx.selectStaff : tx.selectServiceFirst}</option>
                {serviceId ? <option value={BOOKING_ANY_STAFF_ID}>{tx.anyStaff}</option> : null}
                {capableStaff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {staffId && staffId !== BOOKING_ANY_STAFF_ID ? (
                <label className="mt-1.5 flex cursor-pointer items-center gap-2 text-[11px] text-nq-muted">
                  <input
                    type="checkbox"
                    checked={staffRequested}
                    onChange={(e) => setStaffRequested(e.target.checked)}
                    className="h-3.5 w-3.5 accent-rose-500"
                  />
                  {tx.staffRequest}
                </label>
              ) : null}
            </div>

            <div>
              <label className={labelCls}>{tx.date}</label>
              <input
                type="date"
                className={inputCls}
                min={todayYmd()}
                value={ymd}
                onChange={(e) => setYmd(e.target.value)}
                disabled={!staffId}
              />
            </div>

            {staffId && ymd ? (
              <div>
                <label className={labelCls}>{tx.time}</label>
                {slotsLoading ? (
                  <p className="text-xs text-nq-muted">{tx.slotsLoading}</p>
                ) : slots.filter((s) => s.available).length === 0 ? (
                  <p className="text-xs text-nq-muted">{tx.noSlots}</p>
                ) : (
                  <div className="grid max-h-40 grid-cols-3 gap-1.5 overflow-y-auto rounded-md border border-nq-muted/20 bg-nq-bg p-1.5">
                    {slots
                      .filter((s) => s.available)
                      .map((s) => (
                        <button
                          key={s.label}
                          type="button"
                          onClick={() => setSlotLabel(s.label)}
                          className={`rounded px-1 py-1.5 text-xs transition ${
                            slotLabel === s.label
                              ? "bg-nq-primary text-white"
                              : "bg-nq-surface text-nq-foreground hover:bg-nq-primary/15"
                          }`}
                        >
                          {s.label}
                        </button>
                      ))}
                  </div>
                )}
              </div>
            ) : null}

            <div>
              <label className={labelCls}>{tx.notes}</label>
              <input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>

            {error ? <p className="text-xs text-nq-error">{error}</p> : null}

            <button
              type="button"
              disabled={!canSubmit}
              onClick={submit}
              className="mt-1 w-full rounded-md bg-nq-primary py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? tx.submitting : tx.submit}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
