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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  addDeskAppointment,
  getDeskBookingData,
  getResourceAvailability,
} from "@/shared/dashboard/receptionistActions";
import { lookupClientByPhone } from "@/shared/dashboard/lookupClientByPhoneAction";
import {
  searchClients,
  type ClientSearchHit,
} from "@/shared/dashboard/searchClientsAction";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { addonLabel } from "@/shared/booking/serviceLabels";
import { salonToday, salonWallTimeToUtcIso } from "@/shared/lib/salonTime";
import { ymdToLocalNoon } from "@/shared/lib/localDateYmd";
import {
  getAvailableTimeSlots,
  type TimeSlot,
} from "@/shared/booking/getAvailableTimeSlots";
import { computeBookingTiming } from "@/shared/booking/bookingTiming";
import {
  evaluateControlledAfterHours,
  MAX_AFTER_HOURS_EXTENSION_MINUTES,
} from "@/shared/booking/controlledAfterHours";
import { parseTimeSlotToMinutes } from "@/shared/booking/parseBookingTimeSlot";
import {
  NotifyCustomerPanel,
  type NotifyChannels,
} from "./NotifyCustomerPanel";
import {
  type StaffNotificationSettings,
  defaultNotifyOn,
} from "@/shared/dashboard/staffNotificationSettings";
import { buildStaffActionSms } from "@/shared/notifications/staffActionMessages";

type LoadData = Extract<
  Awaited<ReturnType<typeof getDeskBookingData>>,
  { ok: true }
>["data"];

/** Optimistic booking row returned by `addDeskAppointment` on success. */
type DeskCreatedBooking = Extract<
  Awaited<ReturnType<typeof addDeskAppointment>>,
  { ok: true }
>["booking"];

type Props = {
  slug: string;
  salonId: string;
  /** Salon IANA timezone (e.g. "America/Los_Angeles"). The default booking
   * date is "today" in THIS zone, not the receptionist's device zone — a VN
   * device (UTC+7) would otherwise default an LA salon to tomorrow. */
  timezone: string;
  /** Dashboard language — matches the rest of the receptionist center. */
  language: "en" | "vi";
  onClose: () => void;
  /** Called on a successful create. Receives the freshly-built booking row
   * (shaped like one `bookingsForDay` item) so the parent can render it
   * optimistically before the background reload reconciles. */
  onCreated: (booking?: DeskCreatedBooking) => void;
  /** Prefill (grid empty-slot click). Staff may be a UUID or the "any" sentinel. */
  initialServiceId?: string;
  initialStaffId?: string;
  initialYmd?: string;
  /** Desired time label, e.g. "2:00 PM" — auto-selected once it appears free. */
  initialSlotLabel?: string;
  /** Customer prefill for one-tap rebook from the booking drawer. */
  initialPhone?: string;
  initialName?: string;
  /** Per-salon notify config — drives the "notify customer?" panel defaults. */
  notifySettings: StaffNotificationSettings;
  /** Viewport coords of the originating grid click. When set (desktop), the form
   *  opens as a CARD anchored next to the clicked cell so the grid stays visible
   *  — instead of a centered modal that covers it. */
  anchor?: { x: number; y: number };
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
    afterHoursTitle: "After-hours exception",
    afterHoursDescription:
      "Owner/Admin only · selected staff must agree · up to 2 hours after close.",
    showAfterHours: "Show after-hours times",
    hideAfterHours: "Hide after-hours times",
    specificStaffForAfterHours:
      "Choose a specific staff member to request after-hours consent.",
    staffConsent:
      "I confirmed this staff member agreed to work after closing.",
    afterHoursMinutes: (minutes: number) => `${minutes} min after close`,
    afterHoursSubmit: "Accept after-hours booking",
    notes: "Notes (optional)",
    submit: "Create appointment",
    submitting: "Creating…",
    submitError: "Couldn't create the appointment. Try again.",
    newCustomer: "New customer.",
    returning: (vip: string, visits: string) =>
      `✨ Returning customer${vip}${visits} — info filled in.`,
    vipTag: " · VIP",
    visitsTag: (n: number) => ` · ${n} visits`,
    searchHint: "Existing clients — pick one, or keep typing to create new",
    noName: "(no name)",
    prefillHint: (time: string, staff: string) =>
      `${time}${staff ? ` · ${staff}` : ""} — pick a service to confirm.`,
    notify: {
      heading: "Notify customer",
      sms: "Text (SMS)",
      email: "Email",
      previewTitle: "Preview",
      willNotNotify: "Customer won't be notified.",
      noPhone: "no phone",
      noEmail: "no email",
      langEn: "in English",
      langVi: "in Vietnamese",
    },
    resource: "Bed / Room",
    resourceAuto: "Auto",
    resourceLoading: "Checking availability…",
    resourceAvailable: "✓",
    resourceBusy: "✗",
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
      time_in_past: "That time is in the past — pick a later time.",
      time_slot_taken: "That time was just taken — pick another.",
      no_resource_available: "No bed or room is available at this time — try a different slot.",
      outside_hours: "That time is outside the salon's hours.",
      booking_limit_reached: "You've hit your plan's booking limit.",
      unauthorized: "You don't have permission to create bookings.",
      after_hours_not_allowed: "Only an Owner or Admin can approve after-hours.",
      specific_staff_required: "Choose the staff member who agreed to stay.",
      staff_consent_required: "Confirm the selected staff member agreed.",
      after_hours_limit_exceeded: "After-hours is limited to 2 hours past close.",
      invalid_after_hours_override: "This time is already inside normal hours.",
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
    afterHoursTitle: "Ngoại lệ ngoài giờ",
    afterHoursDescription:
      "Chỉ Owner/Admin · phải có sự đồng ý của thợ · tối đa 2 giờ sau khi đóng cửa.",
    showAfterHours: "Hiện giờ ngoài giờ",
    hideAfterHours: "Ẩn giờ ngoài giờ",
    specificStaffForAfterHours:
      "Chọn đúng một thợ để xác nhận họ đồng ý làm ngoài giờ.",
    staffConsent: "Tôi xác nhận thợ này đã đồng ý làm sau giờ đóng cửa.",
    afterHoursMinutes: (minutes: number) => `${minutes} phút sau giờ đóng cửa`,
    afterHoursSubmit: "Nhận lịch ngoài giờ",
    notes: "Ghi chú (tuỳ chọn)",
    submit: "Tạo lịch hẹn",
    submitting: "Đang tạo lịch…",
    submitError: "Không tạo được lịch. Thử lại.",
    newCustomer: "Khách mới.",
    returning: (vip: string, visits: string) =>
      `✨ Khách quen${vip}${visits} — đã điền sẵn.`,
    vipTag: " · VIP",
    visitsTag: (n: number) => ` · ${n} lần ghé`,
    searchHint: "Khách có sẵn — chọn 1, hoặc gõ tiếp để tạo khách mới",
    noName: "(chưa có tên)",
    prefillHint: (time: string, staff: string) =>
      `${time}${staff ? ` · ${staff}` : ""} — chọn dịch vụ để xác nhận.`,
    notify: {
      heading: "Báo cho khách",
      sms: "Tin nhắn (SMS)",
      email: "Email",
      previewTitle: "Xem trước",
      willNotNotify: "Khách sẽ không được báo.",
      noPhone: "chưa có SĐT",
      noEmail: "chưa có email",
      langEn: "bằng tiếng Anh",
      langVi: "bằng tiếng Việt",
    },
    resource: "Giường / Phòng",
    resourceAuto: "Tự động",
    resourceLoading: "Đang kiểm tra…",
    resourceAvailable: "✓",
    resourceBusy: "✗",
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
      time_in_past: "Giờ này đã qua — chọn giờ muộn hơn.",
      time_slot_taken: "Giờ này vừa có người đặt — chọn giờ khác.",
      no_resource_available: "Không còn giường trống giờ này — thử giờ khác.",
      outside_hours: "Giờ này nằm ngoài giờ làm của tiệm.",
      booking_limit_reached: "Đã đạt giới hạn lịch của gói hiện tại.",
      unauthorized: "Bạn không có quyền tạo lịch.",
      after_hours_not_allowed: "Chỉ Owner hoặc Admin được duyệt lịch ngoài giờ.",
      specific_staff_required: "Chọn đúng thợ đã đồng ý ở lại.",
      staff_consent_required: "Xác nhận thợ đã đồng ý làm ngoài giờ.",
      after_hours_limit_exceeded: "Chỉ được kéo dài tối đa 2 giờ sau đóng cửa.",
      invalid_after_hours_override: "Giờ này vẫn nằm trong giờ làm bình thường.",
    } as Record<string, string>,
  },
} as const;


export default function DeskBookingForm({
  slug,
  salonId,
  timezone,
  language,
  onClose,
  onCreated,
  initialServiceId,
  initialStaffId,
  initialYmd,
  initialSlotLabel,
  initialPhone,
  initialName,
  notifySettings,
  anchor,
}: Props) {
  const tx = COPY[language === "vi" ? "vi" : "en"];
  // "Notify customer?" channels for the booking confirmation — pre-checked per
  // the salon's smart per-event default for 'create'.
  const [notifyChannels, setNotifyChannels] = useState<NotifyChannels>(() => {
    const on = defaultNotifyOn(notifySettings, "create");
    return {
      sms: on && notifySettings.channels.sms,
      email: on && notifySettings.channels.email,
    };
  });
  const [data, setData] = useState<LoadData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [phone, setPhone] = useState(initialPhone ?? "");
  const [name, setName] = useState(initialName ?? "");
  const [email, setEmail] = useState("");
  const [serviceId, setServiceId] = useState(initialServiceId ?? "");
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [staffId, setStaffId] = useState(initialStaffId ?? "");
  const [staffRequested, setStaffRequested] = useState(false);
  // Default to the salon's local "today" (not the device's) when not prefilled —
  // a receptionist on a UTC+7 device would otherwise default an LA salon to
  // tomorrow. salonToday resolves the calendar date in the salon timezone.
  const [ymd, setYmd] = useState(
    initialYmd ?? salonToday(timezone, new Date().toISOString()),
  );
  const [slotLabel, setSlotLabel] = useState("");
  const [notes, setNotes] = useState("");
  // Bed/resource picker state (resource-mode salons only).
  const [resourceId, setResourceId] = useState<string | null>(null);
  // Raw fetch result, tagged with the time window it was fetched for. What the
  // picker renders — and whether it is still loading — is derived from that
  // below, so the effect never has to set either synchronously.
  const [fetchedResources, setFetchedResources] = useState<{
    key: string;
    resources: { id: string; name: string; displayOrder: number; isAvailable: boolean }[];
  }>({ key: "", resources: [] });

  // Desired time from a grid click — auto-selected once it shows up free in the
  // freshly-computed slot grid (the grid cell is 30 min, the form grid 15 min,
  // and the real availability depends on the service the user picks here).
  const desiredSlotRef = useRef(initialSlotLabel ?? "");
  const prefilled = !!(initialStaffId || initialYmd || initialSlotLabel);

  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [afterHoursSlots, setAfterHoursSlots] = useState<
    Array<TimeSlot & { afterHoursMinutes: number }>
  >([]);
  const [showAfterHours, setShowAfterHours] = useState(false);
  const [afterHoursConsent, setAfterHoursConsent] = useState(false);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [lookupMsg, setLookupMsg] = useState<string | null>(null);
  // Existing-client typeahead on the name field.
  const [clientHits, setClientHits] = useState<ClientSearchHit[]>([]);
  const [showHits, setShowHits] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Portal target — the modal must escape the (transformed) Front-Desk header,
  // or `position: fixed` is trapped inside it.
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only mount flag for the portal
  useEffect(() => setMounted(true), []);

  // Esc closes the form (QA: modal couldn't be dismissed with Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Anchored-card mode: when opened from a grid click on a wide screen, render
  // as a card next to the clicked cell (grid stays visible) instead of a
  // centered modal. Mobile / header-button (no anchor) → modal.
  const popoverRef = useRef<HTMLDivElement>(null);
  const isWideScreen =
    mounted && typeof window !== "undefined" && window.innerWidth >= 700;
  const anchored = !!anchor && isWideScreen;
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Clamp the card to the viewport, re-measuring as its height changes (slots /
  // notify panel appear). Prefer the side of the click with more room.
  useLayoutEffect(() => {
    if (!anchored || !anchor || !popoverRef.current) return;
    const popover = popoverRef.current;
    const updatePosition = () => {
      const r = popover.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const M = 8;
      const GAP = 14;
      let left = anchor.x + GAP;
      if (left + r.width > vw - M) left = anchor.x - r.width - GAP;
      left = Math.max(M, Math.min(left, vw - r.width - M));
      let top = anchor.y - 28;
      top = Math.max(M, Math.min(top, vh - r.height - M));
      setPos((prev) =>
        prev && prev.left === left && prev.top === top ? prev : { left, top },
      );
    };

    updatePosition();
    const resizeObserver = new ResizeObserver(updatePosition);
    resizeObserver.observe(popover);
    window.addEventListener("resize", updatePosition);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updatePosition);
    };
  }, [anchored, anchor]);

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

  const bookingTiming = useMemo(() => {
    if (!service) {
      return {
        blockMinutes: 0,
        serviceCompletionMinutes: 0,
        trailingBufferMinutes: 0,
      };
    }
    const addOns = addonIds.flatMap((id) => {
      const addOn = data?.addOns.find((item) => item.id === id);
      return addOn
        ? [
            {
              durationMinutes: addOn.durationMinutes,
              bufferMinutes: addOn.bufferMinutes,
              concurrent: addOn.addonConcurrent,
            },
          ]
        : [];
    });
    return computeBookingTiming(
      {
        durationMinutes: service.durationMinutes,
        bufferMinutes: service.bufferMinutes,
      },
      addOns,
    );
  }, [service, addonIds, data]);
  const blockMinutes = bookingTiming.blockMinutes;

  const closedDateYmdSet = useMemo(() => {
    const raw = data?.salon.booking_closed_dates;
    return new Set(Array.isArray(raw) ? (raw as string[]) : []);
  }, [data]);

  const shortestServiceMinutes = useMemo(
    () => (data ? Math.min(...data.services.map((s) => s.totalMinutes)) : 0),
    [data],
  );

  // The exact window the beds are being checked for, or null when the picker
  // does not apply yet (not a resource salon, no slot, no day, no span).
  const resourceWindow = useMemo(() => {
    if (!data?.salon.resourcesEnabled || !slotLabel || !ymd || blockMinutes <= 0) return null;
    const m = slotLabel.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!m) return null;
    let h = Number(m[1]) % 12;
    if (m[3].toUpperCase() === "PM") h += 12;
    const startMin = h * 60 + Number(m[2]);
    const startUtc = salonWallTimeToUtcIso(ymd, startMin, timezone);
    const endMs = Date.parse(startUtc) + blockMinutes * 60 * 1000;
    if (Number.isNaN(endMs)) return null;
    return { startUtc, endUtc: new Date(endMs).toISOString() };
  }, [data, slotLabel, ymd, blockMinutes, timezone]);

  // Both of these are facts about `resourceWindow` vs what has been fetched,
  // so they are derived rather than set from the effect below.
  // Every argument the request is made with, so a different salon on the same
  // time window counts as a different request. JSON.stringify rather than a
  // delimiter so no value can forge a boundary.
  const resourceKey = resourceWindow
    ? JSON.stringify([slug, resourceWindow.startUtc, resourceWindow.endUtc])
    : "";
  const resourceOptions = resourceKey && fetchedResources.key === resourceKey
    ? fetchedResources.resources
    : [];
  const resourceLoading = resourceKey !== "" && fetchedResources.key !== resourceKey;

  // Fetch bed availability when slot is selected (resource-mode salons only).
  useEffect(() => {
    if (!resourceWindow) return;
    const requestKey = resourceKey;
    let cancelled = false;
    void getResourceAvailability(slug, resourceWindow.startUtc, resourceWindow.endUtc)
      .then((res) => {
        if (cancelled) return;
        setFetchedResources({ key: requestKey, resources: res.ok ? res.resources : [] });
      })
      .catch(() => {
        // The action itself rejected — settle the key anyway so the picker
        // stops saying "Checking…" forever.
        if (!cancelled) setFetchedResources({ key: requestKey, resources: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [resourceWindow, resourceKey, slug]);

  // Reset resource choice when key booking inputs change.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reset bed pick when the slot/day/staff changes
  useEffect(() => { setResourceId(null); }, [slotLabel, ymd, staffId]);

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
      setAfterHoursSlots([]);
      return;
    }
    let cancelled = false;
    setSlotsLoading(true);
    setSlotLabel("");
    const baseParams = {
      salonId,
      openingHoursRaw: data.salon.opening_hours,
      selectedDate: ymdToLocalNoon(ymd),
      staffId,
      staffList: capableStaff,
      serviceDurationMinutes: blockMinutes,
      // Only the final cleanup buffer may spill after close. Buffers between
      // sequential services remain part of the customer's completion span.
      // The legacy create RPC receives at most one add-on id. With multiple
      // add-ons it cannot independently prove which buffer is final, so keep
      // the whole block inside hours rather than offer an unsavable slot.
      trailingBufferMinutes:
        addonIds.length <= 1 ? bookingTiming.trailingBufferMinutes : 0,
      closedDateYmdSet,
      shortestServiceMinutes,
      leadMinutes: data.salon.bookingLeadMinutes,
      timezone: data.salon.timezone,
    };
    const canLoadAfterHours =
      data.canBookAfterHours &&
      staffId !== BOOKING_ANY_STAFF_ID &&
      showAfterHours;
    void Promise.all([
      getAvailableTimeSlots(baseParams),
      canLoadAfterHours
        ? getAvailableTimeSlots({
            ...baseParams,
            closingExtensionMinutes: MAX_AFTER_HOURS_EXTENSION_MINUTES,
            allowBeyondStaffShiftEnd: true,
          })
        : Promise.resolve([]),
    ])
      .then(([res, extended]) => {
        if (cancelled) return;
        setSlots(res);
        setAfterHoursSlots(
          extended.flatMap((candidate) => {
            if (!candidate.available) return [];
            const startMinutes = parseTimeSlotToMinutes(candidate.label);
            const check = evaluateControlledAfterHours({
              openingHoursRaw: data.salon.opening_hours,
              bookingClosedDatesRaw: data.salon.booking_closed_dates,
              dateYmd: ymd,
              startMinutes,
              serviceCompletionMinutes:
                addonIds.length <= 1
                  ? bookingTiming.serviceCompletionMinutes
                  : bookingTiming.blockMinutes,
            });
            return check.ok
              ? [{ ...candidate, afterHoursMinutes: check.afterHoursMinutes }]
              : [];
          }),
        );
        // Keep the PREFERRED time (the grid-clicked time, or one the
        // receptionist picked) selected across service / staff / add-on changes,
        // as long as it's still bookable. Previously this fired once then wiped
        // the ref, so choosing a service after clicking a slot dropped the time
        // and left nothing selected. Only give up if the time is unavailable.
        const want = desiredSlotRef.current;
        const match = want
          ? res.find((s) => s.available && s.label === want)
          : null;
        setSlotLabel(match ? match.label : "");
        if (want && !match) desiredSlotRef.current = "";
      })
      .finally(() => {
        if (!cancelled) setSlotsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    data,
    service,
    staffId,
    ymd,
    salonId,
    capableStaff,
    closedDateYmdSet,
    shortestServiceMinutes,
    blockMinutes,
    bookingTiming.blockMinutes,
    bookingTiming.serviceCompletionMinutes,
    bookingTiming.trailingBufferMinutes,
    addonIds.length,
    showAfterHours,
  ]);

  useEffect(() => {
    // Consent belongs to one exact staff/date/service selection and must never
    // silently carry to a different employee or appointment.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- invalidate a consent tied to the prior booking inputs
    setAfterHoursConsent(false);
    setSlotLabel("");
  }, [staffId, ymd, serviceId, addonIds]);

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
        // The lookup resolves after the receptionist may already have typed.
        // Functional updates read the latest field value instead of the empty
        // value captured when the phone effect started, so a slow lookup can
        // never overwrite newer customer input.
        const profileName = p.name?.trim() ?? "";
        const profileEmail = p.email?.trim() ?? "";
        const profileServiceId = p.top_service?.id ?? "";
        const profileStaffId = p.top_staff?.id ?? "";
        if (profileName) setName((current) => current || profileName);
        if (profileEmail) setEmail((current) => current || profileEmail);
        if (profileServiceId)
          setServiceId((current) => current || profileServiceId);
        if (profileStaffId)
          setStaffId((current) => current || profileStaffId);
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

  // Existing-client typeahead: as the receptionist types a NAME, surface this
  // salon's matching clients so they pick the known identity instead of minting
  // a near-duplicate. Skipped while the name was just auto-filled from a phone
  // lookup (selectedHitRef) to avoid reopening the dropdown over a picked client.
  const searchSeq = useRef(0);
  const selectedHitRef = useRef(false);
  useEffect(() => {
    if (selectedHitRef.current) {
      selectedHitRef.current = false;
      return;
    }
    const term = name.trim();
    if (term.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear hits when term too short
      setClientHits([]);
      return;
    }
    const seq = ++searchSeq.current;
    const t = setTimeout(async () => {
      const res = await searchClients(slug, term);
      if (seq !== searchSeq.current) return;
      if (res.ok) {
        setClientHits(res.hits);
        setShowHits(res.hits.length > 0);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [name, slug]);

  const pickClient = useCallback(
    (hit: ClientSearchHit) => {
      // Fill identity from the chosen profile; the phone effect then fills the
      // rest (top service/staff, returning-customer hint).
      selectedHitRef.current = true;
      if (hit.name) setName(hit.name);
      setPhone(hit.phone);
      setShowHits(false);
      setClientHits([]);
    },
    [],
  );

  const toggleAddon = useCallback((id: string) => {
    setAddonIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const selectedAfterHours = afterHoursSlots.find(
    (slot) => slot.label === slotLabel,
  );
  const canSubmit =
    !!name.trim() &&
    phone.replace(/\D/g, "").length >= 10 &&
    !!serviceId &&
    !!staffId &&
    !!ymd &&
    !!slotLabel &&
    (!selectedAfterHours || afterHoursConsent) &&
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
      staffRequestedByClient:
        staffId !== BOOKING_ANY_STAFF_ID && staffRequested,
      bookingDateYmd: ymd,
      timeSlot: slotLabel,
      clientName: name.trim(),
      clientPhone: phone.trim(),
      clientEmail: email.trim() || null,
      clientNotes: notes.trim() || null,
      language,
      notify: {
        sms: notifyChannels.sms && phone.replace(/\D/g, "").length >= 10,
        email: notifyChannels.email && !!email.trim(),
      },
      ...(data?.salon.resourcesEnabled ? { resourceId } : {}),
      ...(selectedAfterHours
        ? {
            afterHoursOverride: {
              staffConsentConfirmed: afterHoursConsent,
            },
          }
        : {}),
    });
    setSubmitting(false);
    if (res.ok) {
      onCreated(res.booking);
      onClose();
    } else {
      setError(tx.errors[res.error] ?? tx.submitError);
    }
  }, [
    canSubmit,
    slug,
    salonId,
    serviceId,
    addonIds,
    staffId,
    staffRequested,
    ymd,
    slotLabel,
    name,
    phone,
    email,
    notes,
    language,
    notifyChannels,
    onCreated,
    onClose,
    tx,
    resourceId,
    data,
    selectedAfterHours,
    afterHoursConsent,
  ]);

  const inputCls =
    "min-h-11 w-full rounded-md border border-nq-muted/30 bg-nq-bg px-3 py-2 text-base text-nq-foreground outline-none focus:border-nq-primary/60";
  const labelCls = "mb-1 block text-base font-medium text-nq-muted";

  if (!mounted) return null;
  return createPortal(
    <div
      // Anchored mode: transparent full-screen catcher (grid stays VISIBLE;
      // outside-click closes). Modal mode: centered with a dark backdrop.
      className={
        anchored
          ? "fixed inset-0 z-[60]"
          : "fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center"
      }
      onClick={onClose}
    >
      <div
        ref={popoverRef}
        className={
          anchored
            ? "fixed z-[61] w-[min(24rem,calc(100vw-1rem))] overflow-y-auto rounded-xl border border-nq-muted/25 bg-nq-surface p-5 shadow-2xl"
            : "w-full max-w-md rounded-xl border border-nq-muted/25 bg-nq-surface p-5 shadow-xl"
        }
        style={
          anchored
            ? {
                left: pos?.left ?? (anchor ? anchor.x + 14 : 0),
                top: pos?.top ?? (anchor ? Math.max(8, anchor.y - 28) : 0),
                maxHeight: "calc(100dvh - 16px)",
              }
            : undefined
        }
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-base font-semibold text-nq-foreground">
            {tx.heading}
          </h2>
          <button
            onClick={onClose}
            className="text-nq-muted hover:text-nq-foreground"
            aria-label={tx.close}
          >
            ✕
          </button>
        </div>
        {prefilled && initialSlotLabel && !slotLabel && ymd === initialYmd ? (
          // The prefill hint shows the time the receptionist CLICKED on the grid.
          // Only show it while still on the clicked day — once they change the
          // date the clicked time no longer applies, and leaving it up made the
          // hinted time disagree with the times the picker suggests for the new
          // date.
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
              {lookupMsg ? (
                <p className="mt-1 text-[11px] text-nq-muted">{lookupMsg}</p>
              ) : null}
            </div>

            <div className="relative">
              <label className={labelCls}>{tx.name}</label>
              <input
                className={inputCls}
                value={name}
                autoComplete="off"
                onChange={(e) => setName(e.target.value)}
                onFocus={() => {
                  if (clientHits.length > 0) setShowHits(true);
                }}
                onBlur={() => {
                  // Delay so an onMouseDown pick registers before the list hides.
                  setTimeout(() => setShowHits(false), 150);
                }}
              />
              {showHits && clientHits.length > 0 ? (
                <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-lg border border-nq-border bg-nq-surface shadow-lg">
                  <p className="border-b border-nq-border px-3 py-1.5 text-[11px] text-nq-muted">
                    {tx.searchHint}
                  </p>
                  <ul className="max-h-56 overflow-y-auto">
                    {clientHits.map((h) => (
                      <li key={h.phone}>
                        <button
                          type="button"
                          // onMouseDown (not onClick) fires before the input's
                          // onBlur, so the pick isn't swallowed by the hide.
                          onMouseDown={(e) => {
                            e.preventDefault();
                            pickClient(h);
                          }}
                          className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left text-base hover:bg-nq-primary/5"
                        >
                          <span className="min-w-0 flex-1 truncate font-medium text-nq-text">
                            {h.name || tx.noName}
                            {h.isVip ? (
                              <span className="ml-1 text-amber-500">★</span>
                            ) : null}
                          </span>
                          <span className="shrink-0 text-xs text-nq-muted">
                            ··· {h.phone.slice(-4)}
                            {h.visitCount > 0 ? tx.visitsTag(h.visitCount) : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
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
                        className={`min-h-11 rounded-full border px-3 py-2 text-sm transition ${
                          on
                            ? "border-nq-primary bg-nq-primary text-white"
                            : "border-nq-muted/30 bg-nq-bg text-nq-foreground hover:border-nq-primary/50"
                        }`}
                      >
                        {on ? "✓ " : "+ "}
                        {addonLabel(a)}
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
                <option value="">
                  {serviceId ? tx.selectStaff : tx.selectServiceFirst}
                </option>
                {serviceId ? (
                  <option value={BOOKING_ANY_STAFF_ID}>{tx.anyStaff}</option>
                ) : null}
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
                min={salonToday(timezone, new Date().toISOString())}
                value={ymd}
                onChange={(e) => setYmd(e.target.value)}
                disabled={!staffId}
              />
            </div>

            {serviceId && staffId && ymd ? (
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
                          onClick={() => {
                            // Becomes the new preferred time so a later add-on
                            // change keeps it selected (sticky, like the grid click).
                            setSlotLabel(s.label);
                            desiredSlotRef.current = s.label;
                          }}
                          className={`min-h-11 rounded px-2 py-2 text-base transition ${
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

            {data.canBookAfterHours && serviceId && staffId && ymd ? (
              <div
                data-testid="desk-after-hours-panel"
                className="rounded-lg border border-amber-400/40 bg-amber-400/10 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-nq-foreground">
                      🌙 {tx.afterHoursTitle}
                    </p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-nq-muted">
                      {tx.afterHoursDescription}
                    </p>
                  </div>
                  {staffId !== BOOKING_ANY_STAFF_ID ? (
                    <button
                      type="button"
                      data-testid="desk-after-hours-toggle"
                      onClick={() => {
                        setShowAfterHours((current) => !current);
                        setSlotLabel("");
                        setAfterHoursConsent(false);
                      }}
                      className="shrink-0 rounded-md border border-amber-500/50 bg-nq-surface px-2.5 py-1.5 text-[11px] font-semibold text-nq-foreground hover:bg-amber-400/15"
                    >
                      {showAfterHours
                        ? tx.hideAfterHours
                        : tx.showAfterHours}
                    </button>
                  ) : null}
                </div>

                {staffId === BOOKING_ANY_STAFF_ID ? (
                  <p className="mt-2 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                    {tx.specificStaffForAfterHours}
                  </p>
                ) : showAfterHours ? (
                  <>
                    {slotsLoading ? (
                      <p className="mt-2 text-xs text-nq-muted">
                        {tx.slotsLoading}
                      </p>
                    ) : afterHoursSlots.length === 0 ? (
                      <p className="mt-2 text-xs text-nq-muted">{tx.noSlots}</p>
                    ) : (
                      <div
                        data-testid="desk-after-hours-slots"
                        className="mt-2 grid max-h-32 grid-cols-3 gap-1.5 overflow-y-auto"
                      >
                        {afterHoursSlots.map((slot) => (
                          <button
                            key={slot.label}
                            type="button"
                            onClick={() => {
                              setSlotLabel(slot.label);
                              desiredSlotRef.current = slot.label;
                              setAfterHoursConsent(false);
                            }}
                            className={`rounded border px-1 py-1.5 text-xs transition ${
                              slotLabel === slot.label
                                ? "border-amber-500 bg-amber-400 text-slate-950"
                                : "border-amber-400/35 bg-nq-surface text-nq-foreground hover:bg-amber-400/15"
                            }`}
                          >
                            <span className="block font-semibold">
                              {slot.label}
                            </span>
                            <span className="block text-[9px] opacity-75">
                              {tx.afterHoursMinutes(slot.afterHoursMinutes)}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                    {selectedAfterHours ? (
                      <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-md bg-nq-surface p-2 text-[11px] leading-relaxed text-nq-foreground">
                        <input
                          type="checkbox"
                          data-testid="desk-after-hours-consent"
                          checked={afterHoursConsent}
                          onChange={(event) =>
                            setAfterHoursConsent(event.target.checked)
                          }
                          className="mt-0.5 h-4 w-4 shrink-0 accent-amber-500"
                        />
                        <span>{tx.staffConsent}</span>
                      </label>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}

            {/* Bed/chair picker — resource-mode salons only, shown once slot is chosen */}
            {data?.salon.resourcesEnabled && slotLabel ? (
              <div data-testid="desk-bed-picker">
                <label className={labelCls}>{tx.resource}</label>
                {resourceLoading ? (
                  <p data-testid="desk-bed-loading" className="text-xs text-nq-muted">{tx.resourceLoading}</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      data-testid="desk-bed-auto"
                      onClick={() => setResourceId(null)}
                      className={`min-h-11 rounded-full border px-3 py-2 text-sm transition ${
                        resourceId === null
                          ? "border-nq-primary bg-nq-primary text-white"
                          : "border-nq-muted/40 bg-nq-surface text-nq-foreground hover:border-nq-primary/40"
                      }`}
                    >
                      {tx.resourceAuto}
                    </button>
                    {resourceOptions.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        data-testid={`desk-bed-${r.id}`}
                        disabled={!r.isAvailable}
                        onClick={() => {
                          if (r.isAvailable) setResourceId(r.id);
                        }}
                        className={`min-h-11 rounded-full border px-3 py-2 text-sm transition ${
                          resourceId === r.id
                            ? "border-nq-primary bg-nq-primary text-white"
                            : r.isAvailable
                              ? "border-nq-muted/40 bg-nq-surface text-nq-foreground hover:border-nq-primary/40"
                              : "cursor-not-allowed border-nq-muted/20 bg-nq-bg text-nq-muted/50 line-through"
                        }`}
                      >
                        🛏 {r.name}{" "}
                        <span className={r.isAvailable ? "text-green-400" : "text-nq-muted/40"}>
                          {r.isAvailable ? tx.resourceAvailable : tx.resourceBusy}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            <div>
              <label className={labelCls}>{tx.notes}</label>
              <input
                className={inputCls}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            {serviceId && slotLabel ? (
              <NotifyCustomerPanel
                value={notifyChannels}
                onChange={setNotifyChannels}
                hasPhone={phone.replace(/\D/g, "").length >= 10}
                hasEmail={!!email.trim()}
                previewText={buildStaffActionSms("create", language, {
                  customerName: name.trim(),
                  salonName: data?.salon.name ?? "",
                  serviceName: service?.name ?? "",
                  whenLabel: `${new Intl.DateTimeFormat(
                    language === "vi" ? "vi-VN" : "en-US",
                    { weekday: "short", month: "short", day: "numeric" },
                  ).format(ymdToLocalNoon(ymd))} · ${slotLabel}`,
                  salonPhone: null,
                })}
                labels={{
                  heading: tx.notify.heading,
                  sms: tx.notify.sms,
                  email: tx.notify.email,
                  previewTitle: tx.notify.previewTitle,
                  willNotNotify: tx.notify.willNotNotify,
                  noPhone: tx.notify.noPhone,
                  noEmail: tx.notify.noEmail,
                  languageNote:
                    language === "vi" ? tx.notify.langVi : tx.notify.langEn,
                }}
              />
            ) : null}

            {error ? <p className="text-xs text-nq-error">{error}</p> : null}

            <button
              type="button"
              disabled={!canSubmit}
              onClick={submit}
              className="mt-1 min-h-11 w-full rounded-md bg-nq-primary px-4 py-2.5 text-base font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting
                ? tx.submitting
                : selectedAfterHours
                  ? tx.afterHoursSubmit
                  : tx.submit}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
