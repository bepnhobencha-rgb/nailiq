"use client";

/**
 * Receptionist "New appointment" form — books a phone-in customer for a FUTURE
 * date/time from the desk (the path until AI Receptionist takes calls). Mirrors
 * the public booking inputs (returning-customer lookup, real availability grid,
 * conflict-safe create) but in one compact desk panel. Slots are computed
 * client-side via `getAvailableTimeSlots`; the create goes through
 * `addDeskAppointment` (conflict-safe RPC) and fires the same confirmation.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  addDeskAppointment,
  getDeskBookingData,
} from "@/shared/dashboard/receptionistActions";
import { lookupClientByPhone } from "@/shared/dashboard/lookupClientByPhoneAction";
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
  onClose: () => void;
  onCreated: () => void;
};

const ERROR_LABEL: Record<string, string> = {
  invalid_name: "Tên không hợp lệ.",
  invalid_name_chars: "Tên chứa ký tự không hợp lệ.",
  invalid_phone: "Số điện thoại không hợp lệ.",
  invalid_email: "Email không hợp lệ.",
  invalid_service: "Vui lòng chọn dịch vụ.",
  invalid_staff: "Vui lòng chọn thợ.",
  invalid_date: "Vui lòng chọn ngày.",
  invalid_time: "Vui lòng chọn giờ.",
  time_slot_taken: "Giờ này vừa có người đặt — chọn giờ khác.",
  booking_limit_reached: "Đã đạt giới hạn lịch của gói hiện tại.",
  unauthorized: "Bạn không có quyền tạo lịch.",
};

function ymdToLocalNoon(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 12, 0, 0);
}

function todayYmd(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

export default function DeskBookingForm({ slug, salonId, onClose, onCreated }: Props) {
  const [data, setData] = useState<LoadData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [staffId, setStaffId] = useState("");
  const [ymd, setYmd] = useState("");
  const [slotLabel, setSlotLabel] = useState("");
  const [notes, setNotes] = useState("");

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

  // Staff capable of the chosen service (capabilityRows null = all-capable).
  const capableStaff = useMemo(() => {
    if (!data) return [];
    if (!serviceId || !data.capabilityRows) return data.staff;
    const ids = new Set(
      data.capabilityRows.filter((r) => r.service_id === serviceId).map((r) => r.staff_id),
    );
    return data.staff.filter((s) => ids.has(s.id));
  }, [data, serviceId]);

  // If the picked staff can't do the newly-picked service, clear it.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reconcile staff to the new service's capability set
    if (staffId && !capableStaff.some((s) => s.id === staffId)) setStaffId("");
  }, [capableStaff, staffId]);

  const service = useMemo(
    () => data?.services.find((s) => s.id === serviceId) ?? null,
    [data, serviceId],
  );

  const closedDateYmdSet = useMemo(() => {
    const raw = data?.salon.booking_closed_dates;
    return new Set(Array.isArray(raw) ? (raw as string[]) : []);
  }, [data]);

  const shortestServiceMinutes = useMemo(
    () => (data ? Math.min(...data.services.map((s) => s.totalMinutes)) : 0),
    [data],
  );

  // Compute the availability grid whenever service + staff + date are set.
  useEffect(() => {
    if (!data || !service || !staffId || !ymd) {
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
      serviceDurationMinutes: service.totalMinutes,
      closedDateYmdSet,
      shortestServiceMinutes,
      leadMinutes: data.salon.bookingLeadMinutes,
      timezone: data.salon.timezone,
    })
      .then((res) => {
        if (cancelled) return;
        setSlots(res);
      })
      .finally(() => {
        if (!cancelled) setSlotsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [data, service, staffId, ymd, salonId, capableStaff, closedDateYmdSet, shortestServiceMinutes]);

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
          `✨ Khách quen${p.is_vip ? " · VIP" : ""}${p.visit_count ? ` · ${p.visit_count} lần ghé` : ""} — đã điền sẵn.`,
        );
      } else {
        setLookupMsg("Khách mới.");
      }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- name/email/serviceId/staffId read as "fill only when empty"; re-running on their change would loop
  }, [phone, slug]);

  const canSubmit =
    !!name.trim() && phone.replace(/\D/g, "").length >= 10 && !!serviceId && !!staffId && !!ymd && !!slotLabel && !submitting;

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const res = await addDeskAppointment(slug, {
      salonId,
      serviceId,
      staffId,
      bookingDateYmd: ymd,
      timeSlot: slotLabel,
      clientName: name.trim(),
      clientPhone: phone.trim(),
      clientEmail: email.trim() || null,
      clientNotes: notes.trim() || null,
    });
    setSubmitting(false);
    if (res.ok) {
      onCreated();
      onClose();
    } else {
      setError(ERROR_LABEL[res.error] ?? "Không tạo được lịch. Thử lại.");
    }
  }, [canSubmit, slug, salonId, serviceId, staffId, ymd, slotLabel, name, phone, email, notes, onCreated, onClose]);

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
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-nq-foreground">Thêm hẹn mới</h2>
          <button onClick={onClose} className="text-nq-muted hover:text-nq-foreground" aria-label="Đóng">
            ✕
          </button>
        </div>

        {loadError ? (
          <p className="text-sm text-nq-error">Không tải được dữ liệu. Thử lại.</p>
        ) : !data ? (
          <p className="text-sm text-nq-muted">Đang tải…</p>
        ) : (
          <div className="space-y-3">
            <div>
              <label className={labelCls}>Số điện thoại *</label>
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
              <label className={labelCls}>Tên khách *</label>
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div>
              <label className={labelCls}>Email (tuỳ chọn — để gửi xác nhận)</label>
              <input
                className={inputCls}
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div>
              <label className={labelCls}>Dịch vụ *</label>
              <select
                className={inputCls}
                value={serviceId}
                onChange={(e) => setServiceId(e.target.value)}
              >
                <option value="">— Chọn dịch vụ —</option>
                {data.services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.priceDisplay ? ` · ${s.priceDisplay}` : ""}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className={labelCls}>Thợ *</label>
              <select
                className={inputCls}
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
                disabled={!serviceId}
              >
                <option value="">{serviceId ? "— Chọn thợ —" : "Chọn dịch vụ trước"}</option>
                {capableStaff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className={labelCls}>Ngày *</label>
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
                <label className={labelCls}>Giờ *</label>
                {slotsLoading ? (
                  <p className="text-xs text-nq-muted">Đang tìm giờ trống…</p>
                ) : slots.filter((s) => s.available).length === 0 ? (
                  <p className="text-xs text-nq-muted">Không còn giờ trống ngày này — chọn ngày khác.</p>
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
              <label className={labelCls}>Ghi chú (tuỳ chọn)</label>
              <input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>

            {error ? <p className="text-xs text-nq-error">{error}</p> : null}

            <button
              type="button"
              disabled={!canSubmit}
              onClick={submit}
              className="mt-1 w-full rounded-md bg-nq-primary py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? "Đang tạo lịch…" : "Tạo lịch hẹn"}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
