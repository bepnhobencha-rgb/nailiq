"use client";

/**
 * Receptionist "Group appointment" form — books a group/party for a FUTURE
 * date from the desk in one compact modal. It REUSES the public group engine
 * end-to-end and never re-implements scheduling:
 *
 *   1. `getDeskBookingData(slug)`     → services / add-ons / staff / capability
 *   2. `loadGroupSmartSchedule(...)`  → AI arrangements (read-only, server-auth)
 *   3. `submitGroupBooking(...)`      → atomic group write (conflict-safe RPC)
 *
 * The arrangement → submit conversion mirrors `BookingGroupFlow.tsx` exactly:
 * the scheduler returns UTC ISO start times, which are converted to salon-local
 * "HH:MM" (24h) via Intl in the salon timezone (DST-safe) before being passed
 * to `submitGroupBooking`. staffId + waveNumber come straight from each
 * assignment.
 *
 * OTP: the desk caller is an authenticated salon member, so `submitGroupBooking`
 * bypasses OTP via the session — we deliberately DO NOT pass `otpSessionId`.
 * The `group_booking` feature flag and booking-cap are enforced server-side by
 * `submitGroupBooking`; this form only gates the entry button (in
 * ReceptionistCenter) on the same per-salon flag.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { lookupClientByPhone } from "@/shared/dashboard/lookupClientByPhoneAction";
import {
  loadLastGroup,
  type RebookMember,
} from "@/shared/dashboard/loadLastGroupAction";
import {
  getDeskBookingData,
  createDeskGroup,
} from "@/shared/dashboard/receptionistActions";
import {
  loadGroupSmartSchedule,
  type GroupArrivalPreference,
  type GroupSmartScheduleResult,
} from "@/shared/booking/loadGroupSmartSchedule";
import {
  loadGroupDayTimeline,
  type GroupDayTimelineResult,
} from "@/shared/booking/loadGroupDayTimeline";
import type { GroupBookingMember } from "@/shared/booking/submitGroupBooking";
import { addonLabel } from "@/shared/booking/serviceLabels";
import {
  buildCapabilityMap,
  filterStaffCapableForService,
} from "@/shared/booking/staffCapability";
import { formatCurrency } from "@/shared/lib/currencyFormat";
import { salonToday } from "@/shared/lib/salonTime";
import { hmToMinutes } from "@/shared/booking/hmToMinutes";
import { computeBookingTiming } from "@/shared/booking/bookingTiming";
import { evaluateControlledAfterHours } from "@/shared/booking/controlledAfterHours";
import { GROUP_MAX_SIZE } from "@/shared/config/constants";
import { MAX_WAVES } from "@/shared/booking/groupSchedulerCore";

type LoadData = Extract<
  Awaited<ReturnType<typeof getDeskBookingData>>,
  { ok: true }
>["data"];

type Props = {
  slug: string;
  /** Accepted for parity with DeskBookingForm's call site, but the group
   *  scheduler + submit engine resolve the salon from `slug` server-side,
   *  so it isn't read here. */
  salonId: string;
  /** Dashboard language — matches the rest of the receptionist center. */
  language: "en" | "vi";
  /** Salon IANA timezone — the date picker defaults/min must be the salon's
   *  "today", not the device's (a VN +7 device would otherwise default an LA
   *  salon to tomorrow). Mirrors DeskBookingForm. */
  timezone: string;
  onClose: () => void;
  onCreated: () => void;
};

type ArrivalKind = GroupArrivalPreference["kind"];

type MemberDraft = {
  name: string;
  serviceId: string;
  /** `null` = "Any available". String UUID = explicit pick. */
  preferredStaffId: string | null;
  addonServiceIds: string[];
};

const MIN_SIZE = 2;
// Upper bound matches the customer-facing online flow (BookingTypeSwitcher):
// staffCount × MAX_WAVES, capped by the GROUP_MAX_SIZE safety ceiling. Computed
// per-salon from the loaded active staff so the desk and online never disagree.
function maxGroupSizeFor(activeStaffCount: number): number {
  if (activeStaffCount <= 0) return MIN_SIZE;
  return Math.max(
    MIN_SIZE,
    Math.min(activeStaffCount * MAX_WAVES, GROUP_MAX_SIZE),
  );
}

// Bilingual copy kept local to the form (UI labels, not config) so it stays
// in lockstep with the rest of the receptionist center's EN/VI toggle.
const COPY = {
  en: {
    heading: "New group appointment",
    close: "Close",
    loadError: "Couldn't load data. Try again.",
    loading: "Loading…",
    peopleLabel: "How many people?",
    member: (n: number) => `Guest ${n}`,
    lead: "lead",
    applyToAll: "Apply this service to everyone",
    namePlaceholder: (n: number) => `Guest ${n}`,
    nameLabel: "Name (optional)",
    service: "Service *",
    selectService: "— Select a service —",
    staff: "Staff",
    anyStaff: "Any available",
    addons: "Add-ons (optional)",
    groupDetails: "Group details",
    phone: "Phone number * (one number for the whole group)",
    leadPhone: "Phone number * (the lead's — used for the whole group)",
    returning: (vip: string, visits: string) =>
      `✨ Returning customer${vip}${visits} — info filled in.`,
    newCustomer: "New customer.",
    vipTag: " · VIP",
    visitsTag: (n: number) => ` · ${n} visits`,
    rebookPill: (n: number) => `🔁 Rebook last group of ${n}`,
    rebookDone: "Group prefilled — pick a date.",
    email: "Email (optional — for the confirmation)",
    date: "Date *",
    arrival: "Arrival time *",
    morning: "Morning",
    afternoon: "Afternoon",
    evening: "Evening",
    specific: "Specific time",
    specificTime: "Pick a time",
    checkingAvailability: "Checking availability…",
    timelineBusy: "Booked",
    seatTogether: "Seat next to each other",
    findTimes: "Find times",
    finding: "Finding open times…",
    noSlots: "No room for the group this day — pick another date or time.",
    altNextDate: (d: string) => `Next opening: ${d}`,
    altEarlier: "Another window is open today",
    chooseArrangement: "Choose an option",
    waves: (n: number) => `Split into ${n} waves`,
    createGroup: "Create group",
    creating: "Creating…",
    fixServices: "Please pick a service for every guest.",
    fixPhone: "Please enter a valid phone number.",
    fixDate: "Please choose a date.",
    fixArrival: "Please choose an arrival time.",
    scheduleErrors: {
      salon_closed: "The salon is closed that day.",
      salon_not_found: "Salon not found.",
      salon_paused: "Booking is paused for this salon.",
      invalid_input: "Please check the group details.",
      server_error: "Something went wrong. Try again.",
      timezone_not_set: "Salon timezone isn't set — contact support.",
    } as Record<string, string>,
    submitErrors: {
      slot_conflict: "A slot was just taken — search again.",
      feature_not_enabled: "Group booking isn't enabled for this salon.",
      salon_closed_day: "The salon is closed that day.",
      invalid_input: "Please check the group details.",
      invalid_group_size: "Group size is out of range.",
      service_not_found: "A service is no longer available.",
      staff_not_found: "A staff member is no longer available.",
      past_date: "Can't book a date in the past.",
      monthly_booking_limit_reached: "You've hit your plan's booking limit.",
      duplicate_submission: "This group was already created.",
      unauthorized: "You don't have permission to create bookings.",
      after_hours_not_allowed:
        "Only an Owner or Admin can approve after-hours.",
      specific_staff_required:
        "Choose a specific staff member for every guest.",
      staff_consent_required:
        "Confirm consent from every selected staff member.",
      after_hours_limit_exceeded:
        "This party would finish more than 2 hours after close.",
      outside_hours:
        "This time is not eligible for a controlled after-hours exception.",
      invalid_after_hours_override:
        "This booking is already inside normal hours.",
      server_error: "Couldn't create the group. Try again.",
    } as Record<string, string>,
    submitFallback: "Couldn't create the group. Try again.",
    afterHoursTitle: "Controlled after-hours group",
    afterHoursBody:
      "Owner/Admin only. Select a specific staff member for every guest and confirm that every selected staff member agreed. Service may finish up to 2 hours after close.",
    afterHoursPickStaff:
      "Select a specific staff member for every guest first.",
    afterHoursConsent:
      "I confirmed every selected staff member agreed to work after closing.",
    createAfterHoursGroup: "Create approved after-hours group",
  },
  vi: {
    heading: "Tạo hẹn nhóm",
    close: "Đóng",
    loadError: "Không tải được dữ liệu. Thử lại.",
    loading: "Đang tải…",
    peopleLabel: "Mấy người?",
    member: (n: number) => `Khách ${n}`,
    lead: "đại diện",
    applyToAll: "Áp dụng dịch vụ này cho cả nhóm",
    namePlaceholder: (n: number) => `Khách ${n}`,
    nameLabel: "Tên (tuỳ chọn)",
    service: "Dịch vụ *",
    selectService: "— Chọn dịch vụ —",
    staff: "Thợ",
    anyStaff: "Thợ nào cũng được",
    addons: "Dịch vụ thêm (tuỳ chọn)",
    groupDetails: "Thông tin chung",
    phone: "Số điện thoại * (1 số dùng cho cả nhóm)",
    leadPhone: "Số điện thoại * (của đại diện — dùng cho cả nhóm)",
    returning: (vip: string, visits: string) =>
      `✨ Khách quen${vip}${visits} — đã điền sẵn.`,
    newCustomer: "Khách mới.",
    vipTag: " · VIP",
    visitsTag: (n: number) => ` · ${n} lần ghé`,
    rebookPill: (n: number) => `🔁 Đặt lại nhóm ${n} người gần nhất`,
    rebookDone: "Đã điền sẵn nhóm — chọn ngày là xong.",
    email: "Email (tuỳ chọn — để gửi xác nhận)",
    date: "Ngày *",
    arrival: "Giờ đến *",
    morning: "Sáng",
    afternoon: "Chiều",
    evening: "Tối",
    specific: "Giờ cụ thể",
    specificTime: "Chọn giờ",
    checkingAvailability: "Đang kiểm tra giờ trống…",
    timelineBusy: "Đã có khách",
    seatTogether: "Ngồi cạnh nhau",
    findTimes: "Tìm giờ",
    finding: "Đang tìm giờ trống…",
    noSlots: "Không còn chỗ cho nhóm ngày này — chọn ngày/giờ khác.",
    altNextDate: (d: string) => `Ngày trống gần nhất: ${d}`,
    altEarlier: "Có khung giờ khác trống hôm nay",
    chooseArrangement: "Chọn phương án",
    waves: (n: number) => `Chia thành ${n} đợt`,
    createGroup: "Tạo nhóm",
    creating: "Đang tạo nhóm…",
    fixServices: "Vui lòng chọn dịch vụ cho mỗi khách.",
    fixPhone: "Vui lòng nhập số điện thoại hợp lệ.",
    fixDate: "Vui lòng chọn ngày.",
    fixArrival: "Vui lòng chọn giờ đến.",
    scheduleErrors: {
      salon_closed: "Tiệm đóng cửa ngày này.",
      salon_not_found: "Không tìm thấy tiệm.",
      salon_paused: "Tiệm đang tạm ngừng nhận lịch.",
      invalid_input: "Vui lòng kiểm tra lại thông tin nhóm.",
      server_error: "Có lỗi xảy ra. Thử lại.",
      timezone_not_set: "Tiệm chưa cài múi giờ — liên hệ hỗ trợ.",
    } as Record<string, string>,
    submitErrors: {
      slot_conflict: "Khung giờ vừa bị đặt mất — tìm lại giúp.",
      feature_not_enabled: "Tiệm chưa bật đặt lịch nhóm.",
      salon_closed_day: "Tiệm đóng cửa ngày này.",
      invalid_input: "Vui lòng kiểm tra lại thông tin nhóm.",
      invalid_group_size: "Số người ngoài phạm vi.",
      service_not_found: "Một dịch vụ không còn khả dụng.",
      staff_not_found: "Một thợ không còn khả dụng.",
      past_date: "Không thể đặt vào ngày đã qua.",
      monthly_booking_limit_reached: "Đã đạt giới hạn lịch của gói hiện tại.",
      duplicate_submission: "Nhóm này đã được tạo.",
      unauthorized: "Bạn không có quyền tạo lịch.",
      after_hours_not_allowed: "Chỉ Owner hoặc Admin được duyệt ngoài giờ.",
      specific_staff_required: "Hãy chọn rõ thợ cho từng khách.",
      staff_consent_required: "Hãy xác nhận tất cả thợ đã đồng ý.",
      after_hours_limit_exceeded:
        "Nhóm này sẽ kết thúc quá 2 giờ sau khi đóng cửa.",
      outside_hours: "Giờ này không đủ điều kiện ngoại lệ ngoài giờ.",
      invalid_after_hours_override:
        "Lịch này vẫn nằm trong giờ hoạt động bình thường.",
      server_error: "Không tạo được nhóm. Thử lại.",
    } as Record<string, string>,
    submitFallback: "Không tạo được nhóm. Thử lại.",
    afterHoursTitle: "Nhóm ngoài giờ có kiểm soát",
    afterHoursBody:
      "Chỉ Owner/Admin. Phải chọn rõ thợ cho từng khách và xác nhận tất cả thợ đã đồng ý. Dịch vụ được kết thúc tối đa 2 giờ sau khi tiệm đóng cửa.",
    afterHoursPickStaff: "Trước tiên hãy chọn rõ thợ cho từng khách.",
    afterHoursConsent:
      "Tôi xác nhận tất cả thợ đã chọn đồng ý làm sau giờ đóng cửa.",
    createAfterHoursGroup: "Tạo nhóm ngoài giờ đã duyệt",
  },
} as const;

// `salonId` is passed to createDeskGroup for its salon-scope auth check.
export default function DeskGroupForm({
  slug,
  salonId,
  language,
  timezone,
  onClose,
  onCreated,
}: Props) {
  const tx = COPY[language === "vi" ? "vi" : "en"];
  const [data, setData] = useState<LoadData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [size, setSize] = useState(MIN_SIZE);
  const [members, setMembers] = useState<MemberDraft[]>(() => [
    { name: "", serviceId: "", preferredStaffId: null, addonServiceIds: [] },
    { name: "", serviceId: "", preferredStaffId: null, addonServiceIds: [] },
  ]);

  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [leadLookupMsg, setLeadLookupMsg] = useState<string | null>(null);
  // "Đặt lại nhóm gần nhất": last group this lead organized, offered as a prefill.
  const [lastGroup, setLastGroup] = useState<RebookMember[] | null>(null);
  const [rebookMsg, setRebookMsg] = useState<string | null>(null);
  // Default to the salon's local "today" (not the device's) — a VN +7 device
  // would otherwise default an LA salon to tomorrow + show past slots.
  const [ymd, setYmd] = useState(() =>
    salonToday(timezone, new Date().toISOString()),
  );
  const [arrivalKind, setArrivalKind] = useState<ArrivalKind>("morning");
  const [specificTime, setSpecificTime] = useState("");
  // Visual busy/free preview shown alongside the "Specific time" picker —
  // purely additive: a fetch failure just leaves this null and the native
  // time input above keeps working exactly as before.
  const [dayTimeline, setDayTimeline] = useState<GroupDayTimelineResult | null>(
    null,
  );
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [seatTogether, setSeatTogether] = useState(true);
  const [afterHoursConsent, setAfterHoursConsent] = useState(false);

  const [scheduling, setScheduling] = useState(false);
  const [scheduleResult, setScheduleResult] =
    useState<GroupSmartScheduleResult | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Portal mount flag — the modal must escape the (transformed) header so
  // position:fixed isn't trapped inside it.
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only mount flag for the portal
  useEffect(() => setMounted(true), []);

  // Load services / add-ons / staff / capability once.
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

  const capability = useMemo(
    () => buildCapabilityMap(data?.capabilityRows ?? null),
    [data?.capabilityRows],
  );

  // Per-salon party-size ceiling, matching the online flow exactly.
  const maxSize = useMemo(
    () => maxGroupSizeFor(data?.staff?.length ?? 0),
    [data?.staff?.length],
  );

  // Grow/shrink the member list with the size pill, preserving prior rows.
  const applySize = useCallback(
    (n: number) => {
      const clamped = Math.max(MIN_SIZE, Math.min(maxSize, Math.round(n)));
      setSize(clamped);
      setMembers((prev) => {
        const next: MemberDraft[] = [];
        for (let i = 0; i < clamped; i++) {
          next.push(
            prev[i] ?? {
              name: "",
              serviceId: "",
              preferredStaffId: null,
              addonServiceIds: [],
            },
          );
        }
        return next;
      });
      setScheduleResult(null);
      setAfterHoursConsent(false);
    },
    [maxSize],
  );

  const patchMember = useCallback(
    (i: number, patch: Partial<MemberDraft>) => {
      setMembers((prev) => {
        const next = prev.slice();
        next[i] = { ...next[i], ...patch };
        // If the service changed, drop a preferred staff who can't do it.
        if (patch.serviceId !== undefined && capability) {
          const sid = next[i].preferredStaffId;
          if (sid && !(capability.get(sid)?.has(patch.serviceId) ?? false)) {
            next[i] = { ...next[i], preferredStaffId: null };
          }
        }
        return next;
      });
      // Any member edit invalidates prior schedule results.
      setScheduleResult(null);
      setError(null);
      setAfterHoursConsent(false);
    },
    [capability],
  );

  // Returning-customer recognition for the LEAD (đại diện), phone-first — mirrors
  // DeskBookingForm + the online group flow. Looking up the lead's phone fills
  // Guest 1's name (and service/staff when empty) so the receptionist doesn't
  // retype a known customer. Debounced; only fills blank fields.
  const lookupSeq = useRef(0);
  useEffect(() => {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 8) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear hint when phone too short
      setLeadLookupMsg(null);
      setLastGroup(null);
      return;
    }
    const seq = ++lookupSeq.current;
    const t = setTimeout(async () => {
      // Offer to rebook the last group this lead organized (>= 2 members).
      void loadLastGroup(slug, phone).then((g) => {
        if (seq !== lookupSeq.current) return;
        setLastGroup(g.ok && g.found && g.memberCount >= 2 ? g.members : null);
      });
      const res = await lookupClientByPhone(slug, phone);
      if (seq !== lookupSeq.current) return;
      // A name to show only if the profile actually carries one (a known
      // customer can exist without a stored name, e.g. an old import). Don't
      // claim "đã điền sẵn" when we filled nothing.
      const resolvedName =
        res.ok && res.found ? (res.profile.name ?? "").trim() : "";
      if (res.ok && res.found && resolvedName) {
        const p = res.profile;
        setMembers((prev) => {
          const next = prev.slice();
          const lead = next[0];
          if (!lead) return prev;
          next[0] = {
            ...lead,
            name: lead.name || resolvedName,
            serviceId: lead.serviceId || p.top_service?.id || "",
            preferredStaffId: lead.preferredStaffId ?? p.top_staff?.id ?? null,
          };
          return next;
        });
        if (p.email && !email) setEmail(p.email);
        setLeadLookupMsg(
          tx.returning(
            p.is_vip ? tx.vipTag : "",
            p.visit_count ? tx.visitsTag(p.visit_count) : "",
          ),
        );
      } else {
        setLeadLookupMsg(tx.newCustomer);
      }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fill-when-empty; re-running on members/email change would loop
  }, [phone, slug]);

  // Prefill the whole party from the lead's last group (one tap), then the
  // receptionist just picks a date. Clamped to the per-salon size ceiling.
  const applyLastGroup = useCallback(() => {
    if (!lastGroup || lastGroup.length === 0) return;
    const clamped = lastGroup.slice(
      0,
      Math.max(MIN_SIZE, Math.min(maxSize, lastGroup.length)),
    );
    setSize(clamped.length);
    setMembers(
      clamped.map((m) => ({
        name: m.name,
        serviceId: m.serviceId,
        preferredStaffId: m.preferredStaffId,
        addonServiceIds: m.addonServiceIds.slice(),
      })),
    );
    setScheduleResult(null);
    setAfterHoursConsent(false);
    setError(null);
    setRebookMsg(tx.rebookDone);
  }, [lastGroup, maxSize, tx]);

  const toggleAddon = useCallback((i: number, addonId: string) => {
    setMembers((prev) => {
      const next = prev.slice();
      const cur = next[i].addonServiceIds;
      next[i] = {
        ...next[i],
        addonServiceIds: cur.includes(addonId)
          ? cur.filter((id) => id !== addonId)
          : [...cur, addonId],
      };
      return next;
    });
    setScheduleResult(null);
  }, []);

  // Quick-fill: copy the lead (guest 1)'s service + add-ons to everyone — the
  // common "whole group wants the same thing" case. Preferred staff is reset to
  // auto for the copied guests (one tech can't serve all at once, and the lead's
  // tech may not even do the new service); each guest can still override after.
  const applyServiceToAll = useCallback(() => {
    setMembers((prev) => {
      const lead = prev[0];
      if (!lead?.serviceId) return prev;
      return prev.map((m, idx) =>
        idx === 0
          ? m
          : {
              ...m,
              serviceId: lead.serviceId,
              addonServiceIds: [...lead.addonServiceIds],
              preferredStaffId: null,
            },
      );
    });
    setScheduleResult(null);
  }, []);

  const arrivalPref: GroupArrivalPreference = useMemo(() => {
    if (arrivalKind === "specific")
      return { kind: "specific", time: specificTime };
    return { kind: arrivalKind };
  }, [arrivalKind, specificTime]);

  const digits = phone.replace(/\D/g, "");
  const allServicesPicked = members.every((m) => !!m.serviceId);
  const arrivalOk = arrivalKind !== "specific" || specificTime.length > 0;
  const everyMemberHasSpecificStaff = members.every(
    (member) => member.preferredStaffId != null,
  );

  // UI preview only; the server repeats every rule with authoritative rows.
  // This tells management whether the exact requested time is genuinely an
  // after-hours case (rather than merely a busy in-hours slot).
  const controlledAfterHoursEligible = useMemo(() => {
    if (
      !data?.canBookAfterHours ||
      arrivalKind !== "specific" ||
      !specificTime ||
      !ymd ||
      !allServicesPicked
    ) {
      return false;
    }
    const startMinutes = hmToMinutes(specificTime);
    if (!Number.isFinite(startMinutes)) return false;
    let hasAfterHoursMember = false;
    for (const member of members) {
      const service = data.services.find(
        (item) => item.id === member.serviceId,
      );
      if (!service) return false;
      const addOns = member.addonServiceIds.flatMap((id) => {
        const addOn = data.addOns.find((item) => item.id === id);
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
      const timing = computeBookingTiming(
        {
          durationMinutes: service.durationMinutes,
          bufferMinutes: service.bufferMinutes,
        },
        addOns,
      );
      const evaluation = evaluateControlledAfterHours({
        openingHoursRaw: data.salon.opening_hours,
        bookingClosedDatesRaw: data.salon.booking_closed_dates,
        dateYmd: ymd,
        startMinutes,
        serviceCompletionMinutes: timing.serviceCompletionMinutes,
      });
      if (evaluation.ok) hasAfterHoursMember = true;
      else if (evaluation.reason !== "inside_hours") return false;
    }
    return hasAfterHoursMember;
  }, [data, arrivalKind, specificTime, ymd, allServicesPicked, members]);

  const showControlledAfterHours =
    controlledAfterHoursEligible &&
    scheduleResult?.ok === false &&
    scheduleResult.reason === "no_slots";

  // ── Find times ─────────────────────────────────────────────────
  const runScheduler = useCallback(async () => {
    setError(null);
    if (!allServicesPicked) {
      setError(tx.fixServices);
      return;
    }
    if (!ymd) {
      setError(tx.fixDate);
      return;
    }
    if (!arrivalOk) {
      setError(tx.fixArrival);
      return;
    }
    setScheduling(true);
    setScheduleResult(null);
    setSelectedIdx(0);
    try {
      const res = await loadGroupSmartSchedule({
        shopSlug: slug,
        date: ymd,
        arrivalPref,
        // Read-path member shape: name + service + preferred staff + add-ons.
        members: members.map((m) => ({
          name: m.name.trim(),
          serviceId: m.serviceId,
          preferredStaffId: m.preferredStaffId,
          addonServiceIds: m.addonServiceIds,
        })),
        // Desk groups arrive together (default scheduler mode).
        mode: "sync_start",
      });
      setScheduleResult(res);
    } catch (e) {
      console.error("[DeskGroupForm] scheduler failed", e);
      setScheduleResult({ ok: false, reason: "server_error" });
    } finally {
      setScheduling(false);
    }
  }, [allServicesPicked, ymd, arrivalOk, arrivalPref, members, slug, tx]);

  // ── Visual busy/free preview for "Specific time" ──────────────────
  // Purely additive: on any failure this just leaves dayTimeline null and
  // the native time input above (unaffected by this effect) keeps working.
  const memberServicesKey = useMemo(
    () =>
      JSON.stringify(
        members.map((m) => [
          m.serviceId,
          m.addonServiceIds,
          m.preferredStaffId,
        ]),
      ),
    [members],
  );

  useEffect(() => {
    if (arrivalKind !== "specific" || !allServicesPicked || !ymd) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset preview when leaving specific-time mode
      setDayTimeline(null);
      return;
    }
    let cancelled = false;
    setTimelineLoading(true);
    loadGroupDayTimeline({
      shopSlug: slug,
      date: ymd,
      members: members.map((m) => ({
        serviceId: m.serviceId,
        addonServiceIds: m.addonServiceIds,
        preferredStaffId: m.preferredStaffId,
      })),
    })
      .then((res) => {
        if (!cancelled) setDayTimeline(res);
      })
      .catch(() => {
        if (!cancelled) setDayTimeline(null);
      })
      .finally(() => {
        if (!cancelled) setTimelineLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- memberServicesKey is the stable proxy for members
  }, [arrivalKind, allServicesPicked, ymd, memberServicesKey, slug]);

  // ── Create group ───────────────────────────────────────────────
  const createGroup = useCallback(async () => {
    if (submitting) return;
    const usingControlledAfterHours =
      showControlledAfterHours &&
      everyMemberHasSpecificStaff &&
      afterHoursConsent;
    const selectedArrangement =
      scheduleResult?.ok === true
        ? scheduleResult.arrangements[selectedIdx]
        : null;
    if ((!selectedArrangement && !usingControlledAfterHours) || !data) {
      return;
    }
    if (digits.length < 10) {
      setError(tx.fixPhone);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const timezone = data.salon.timezone;
      // Map each assignment → salon-local "HH:MM" (24h). The scheduler returns
      // UTC ISO; submitGroupBooking expects salon-local time. Convert via Intl
      // in the salon timezone so DST is handled correctly. (Mirrors
      // BookingGroupFlow.tsx onSubmit exactly.)
      const payload: GroupBookingMember[] = usingControlledAfterHours
        ? members.map((draft, memberIndex) => ({
            name: draft.name.trim() || tx.namePlaceholder(memberIndex + 1),
            phone: memberIndex === 0 ? phone : "",
            email: memberIndex === 0 ? email.trim() || undefined : undefined,
            serviceId: draft.serviceId,
            staffId: draft.preferredStaffId!,
            date: ymd,
            time: specificTime,
            waveNumber: 1,
            addonServiceIds: draft.addonServiceIds,
          }))
        : selectedArrangement!.assignments
            .slice()
            .sort((a, b) => a.memberIndex - b.memberIndex)
            .map((a) => {
              const draft = members[a.memberIndex];
              const parts = new Intl.DateTimeFormat("en-US", {
                timeZone: timezone,
                hour: "2-digit",
                minute: "2-digit",
                hourCycle: "h23",
              }).formatToParts(new Date(a.startUtcIso));
              const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
              const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
              const time24 = `${hh}:${mm}`;
              // Identity Layer: only the lead/đại diện (member 0) carries the
              // contact phone+email. Other guests have no contact of their own, so
              // they go in with an empty phone and the server marks them
              // is_party_member — instead of copying the lead's number onto every
              // row (the root cause of one phone fanning out into many names).
              const isLead = a.memberIndex === 0;
              return {
                name:
                  draft?.name.trim() || tx.namePlaceholder(a.memberIndex + 1),
                phone: isLead ? phone : "",
                email: isLead ? email.trim() || undefined : undefined,
                serviceId: draft?.serviceId ?? "",
                staffId: a.staffId,
                date: ymd,
                time: time24,
                waveNumber: a.waveNumber,
                addonServiceIds: draft?.addonServiceIds ?? [],
              };
            });

      // Desk wrapper: enforces receptionist auth + mints the OTP session
      // server-side when the salon requires phone-OTP (the receptionist vouches
      // in person). Reuses the same submitGroupBooking engine underneath.
      const res = await createDeskGroup(slug, {
        salonId,
        members: payload,
        seatTogether,
        language,
        idempotencyKey: crypto.randomUUID(),
        ...(usingControlledAfterHours
          ? { afterHoursOverride: { staffConsentConfirmed: true } }
          : {}),
      });
      if (res.ok) {
        onCreated();
        onClose();
        return;
      }
      setError(tx.submitErrors[res.reason] ?? tx.submitFallback);
    } catch (e) {
      console.error("[DeskGroupForm] submit failed", e);
      setError(tx.submitFallback);
    } finally {
      setSubmitting(false);
    }
  }, [
    submitting,
    scheduleResult,
    selectedIdx,
    data,
    showControlledAfterHours,
    everyMemberHasSpecificStaff,
    afterHoursConsent,
    digits.length,
    members,
    phone,
    email,
    ymd,
    specificTime,
    salonId,
    seatTogether,
    language,
    slug,
    onCreated,
    onClose,
    tx,
  ]);

  const inputCls =
    "w-full rounded-md border border-nq-muted/30 bg-nq-bg px-3 py-2 text-sm text-nq-foreground outline-none focus:border-nq-primary/60";
  const labelCls = "mb-1 block text-xs font-medium text-nq-muted";
  const pillCls = (active: boolean) =>
    `rounded-full px-3 py-1.5 text-xs font-medium transition ${
      active
        ? "bg-nq-primary text-white"
        : "bg-nq-surface text-nq-foreground hover:bg-nq-primary/15 border border-nq-muted/25"
    }`;
  const tickCls = (active: boolean, feasible: boolean) => {
    if (active)
      return "min-h-11 rounded-md bg-nq-primary px-1.5 py-1.5 text-xs font-medium text-white transition";
    if (!feasible)
      return "min-h-11 cursor-not-allowed rounded-md border border-nq-muted/15 bg-nq-surface/40 px-1.5 py-1.5 text-xs text-nq-muted/50 line-through transition";
    return "min-h-11 rounded-md border border-nq-muted/25 bg-nq-surface px-1.5 py-1.5 text-xs text-nq-foreground transition hover:bg-nq-primary/15";
  };

  if (!mounted) return null;

  // Build the arrangement option cards from a successful result.
  const arrangements =
    scheduleResult && scheduleResult.ok ? scheduleResult.arrangements : [];

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="my-auto w-full max-w-lg rounded-xl border border-nq-muted/25 bg-nq-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
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

        {loadError ? (
          <p className="text-sm text-nq-error">{tx.loadError}</p>
        ) : !data ? (
          <p className="text-sm text-nq-muted">{tx.loading}</p>
        ) : (
          <div className="space-y-4">
            {/* Step 1 — group size */}
            <div>
              <label className={labelCls}>{tx.peopleLabel}</label>
              <div className="flex flex-wrap gap-1.5">
                {Array.from(
                  { length: maxSize - MIN_SIZE + 1 },
                  (_, k) => k + MIN_SIZE,
                ).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => applySize(n)}
                    className={pillCls(size === n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* Step 2 — per-member service / staff / add-ons */}
            <div className="space-y-3">
              {members.map((m, i) => {
                const capableStaff = filterStaffCapableForService(
                  data.staff,
                  capability,
                  m.serviceId || null,
                );
                return (
                  <div
                    key={i}
                    className="rounded-lg border border-nq-muted/20 bg-nq-bg p-3"
                  >
                    <p className="mb-2 text-xs font-semibold text-nq-foreground">
                      {tx.member(i + 1)}
                      {i === 0 ? (
                        <span className="ml-1 font-normal text-nq-primary">
                          · {tx.lead}
                        </span>
                      ) : null}
                    </p>
                    {/* Lead enters phone FIRST (phone-first) — one number for the
                        whole group, with returning-customer recognition. */}
                    {i === 0 ? (
                      <div className="mb-2">
                        <input
                          className={inputCls}
                          inputMode="tel"
                          placeholder="+1 (604) 555-1234"
                          aria-label={tx.leadPhone}
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                        />
                        {leadLookupMsg ? (
                          <p className="mt-1 text-[11px] text-nq-primary">
                            {leadLookupMsg}
                          </p>
                        ) : null}
                        {/* One-tap: prefill the lead's last group for a new date. */}
                        {lastGroup && lastGroup.length >= 2 ? (
                          <button
                            type="button"
                            onClick={applyLastGroup}
                            data-testid="rebook-last-group"
                            className="mt-2 rounded-full border border-nq-primary/50 bg-nq-primary/10 px-3 py-1.5 text-xs font-medium text-nq-primary hover:bg-nq-primary/20"
                          >
                            {tx.rebookPill(lastGroup.length)}
                          </button>
                        ) : null}
                        {rebookMsg ? (
                          <p className="mt-1 text-[11px] text-nq-muted">
                            {rebookMsg}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    <input
                      className={`${inputCls} mb-2`}
                      placeholder={tx.namePlaceholder(i + 1)}
                      aria-label={tx.nameLabel}
                      value={m.name}
                      onChange={(e) => patchMember(i, { name: e.target.value })}
                    />
                    {/* Lead's email (optional) lives with their contact info, not
                        in a separate section — auto-filled by the phone lookup. */}
                    {i === 0 ? (
                      <input
                        className={`${inputCls} mb-2`}
                        inputMode="email"
                        placeholder={tx.email}
                        aria-label={tx.email}
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                      />
                    ) : null}
                    <select
                      className={`${inputCls} mb-2`}
                      aria-label={tx.service}
                      value={m.serviceId}
                      onChange={(e) =>
                        patchMember(i, { serviceId: e.target.value })
                      }
                    >
                      <option value="">{tx.selectService}</option>
                      {data.services.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                          {s.priceDisplay ? ` · ${s.priceDisplay}` : ""}
                        </option>
                      ))}
                    </select>
                    <select
                      className={`${inputCls} ${data.addOns.length > 0 ? "mb-2" : ""}`}
                      aria-label={tx.staff}
                      value={m.preferredStaffId ?? ""}
                      disabled={!m.serviceId}
                      onChange={(e) =>
                        patchMember(i, {
                          preferredStaffId: e.target.value || null,
                        })
                      }
                    >
                      <option value="">{tx.anyStaff}</option>
                      {capableStaff.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    {data.addOns.length > 0 ? (
                      <div>
                        <p className="mb-1 text-[11px] text-nq-muted">
                          {tx.addons}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {data.addOns.map((a) => {
                            const on = m.addonServiceIds.includes(a.id);
                            return (
                              <button
                                key={a.id}
                                type="button"
                                onClick={() => toggleAddon(i, a.id)}
                                className={pillCls(on)}
                              >
                                {on ? "✓ " : "+ "}
                                {addonLabel(a)}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                    {i === 0 && members.length > 1 && m.serviceId ? (
                      <button
                        type="button"
                        data-testid="group-apply-service-to-all"
                        onClick={applyServiceToAll}
                        className="mt-2 w-full rounded-md border border-nq-primary/40 bg-nq-primary/10 py-1.5 text-xs font-semibold text-nq-primary transition hover:bg-nq-primary/15"
                      >
                        ↓ {tx.applyToAll}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {/* Step 3 — group-level scheduling. Contact info (phone/name/email)
                lives entirely in the lead block above; there is no separate
                organizer name/email here (it duplicated the lead + was unused). */}
            <div className="space-y-3 rounded-lg border border-nq-muted/20 bg-nq-bg p-3">
              <p className="text-xs font-semibold text-nq-foreground">
                {tx.groupDetails}
              </p>
              <div>
                <label className={labelCls}>{tx.date}</label>
                <input
                  type="date"
                  className={`${inputCls} [color-scheme:dark]`}
                  min={salonToday(timezone, new Date().toISOString())}
                  value={ymd}
                  onChange={(e) => {
                    setYmd(e.target.value);
                    setScheduleResult(null);
                    setAfterHoursConsent(false);
                  }}
                />
              </div>
              <div>
                <label className={labelCls}>{tx.arrival}</label>
                <div className="flex flex-wrap gap-1.5">
                  {(
                    [
                      ["morning", tx.morning],
                      ["afternoon", tx.afternoon],
                      ["evening", tx.evening],
                      ["specific", tx.specific],
                    ] as [ArrivalKind, string][]
                  ).map(([kind, label]) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => {
                        setArrivalKind(kind);
                        setScheduleResult(null);
                        setAfterHoursConsent(false);
                      }}
                      className={pillCls(arrivalKind === kind)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {arrivalKind === "specific" ? (
                  <>
                    <input
                      type="time"
                      className={`${inputCls} mt-2 [color-scheme:dark]`}
                      aria-label={tx.specificTime}
                      value={specificTime}
                      onChange={(e) => {
                        setSpecificTime(e.target.value);
                        setScheduleResult(null);
                        setAfterHoursConsent(false);
                      }}
                    />
                    {timelineLoading ? (
                      <div className="mt-2 grid grid-cols-4 gap-1.5 sm:grid-cols-6">
                        {Array.from({ length: 12 }).map((_, i) => (
                          <div
                            key={i}
                            className="h-11 animate-pulse rounded-md bg-nq-surface/60"
                          />
                        ))}
                      </div>
                    ) : dayTimeline && dayTimeline.ok ? (
                      <div className="mt-2 space-y-2">
                        {(["morning", "afternoon", "evening"] as const).map(
                          (section) => {
                            const sectionTicks = dayTimeline.ticks.filter(
                              (t) => {
                                const mins = hmToMinutes(t.time);
                                if (section === "morning") return mins < 720;
                                if (section === "afternoon")
                                  return mins >= 720 && mins < 1020;
                                return mins >= 1020;
                              },
                            );
                            if (sectionTicks.length === 0) return null;
                            return (
                              <div key={section}>
                                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-nq-muted">
                                  {tx[section]}
                                </div>
                                <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
                                  {sectionTicks.map((t) => (
                                    <button
                                      key={t.time}
                                      type="button"
                                      disabled={!t.feasible}
                                      title={
                                        !t.feasible
                                          ? tx.timelineBusy
                                          : undefined
                                      }
                                      onClick={() => {
                                        setSpecificTime(t.time);
                                        setScheduleResult(null);
                                        setAfterHoursConsent(false);
                                      }}
                                      className={tickCls(
                                        specificTime === t.time,
                                        t.feasible,
                                      )}
                                    >
                                      {t.label}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            );
                          },
                        )}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-nq-foreground">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-nq-primary"
                  checked={seatTogether}
                  onChange={(e) => setSeatTogether(e.target.checked)}
                />
                {tx.seatTogether}
              </label>
            </div>

            {/* Step 4 — find times */}
            <button
              type="button"
              disabled={scheduling || !allServicesPicked}
              onClick={() => void runScheduler()}
              className="w-full rounded-md bg-nq-primary py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {scheduling ? tx.finding : tx.findTimes}
            </button>

            {/* Schedule results */}
            {scheduleResult && !scheduleResult.ok ? (
              <div className="rounded-lg border border-nq-muted/20 bg-nq-bg p-3 text-sm text-nq-muted">
                {scheduleResult.reason === "no_slots" ? (
                  <>
                    <p>{tx.noSlots}</p>
                    {scheduleResult.alternatives.nextAvailableDate ? (
                      <p className="mt-1 text-[11px]">
                        {tx.altNextDate(
                          scheduleResult.alternatives.nextAvailableDate.date,
                        )}
                      </p>
                    ) : null}
                    {scheduleResult.alternatives.earlierToday ? (
                      <p className="mt-1 text-[11px]">{tx.altEarlier}</p>
                    ) : null}
                  </>
                ) : (
                  <p>
                    {tx.scheduleErrors[scheduleResult.reason] ??
                      tx.scheduleErrors.server_error}
                  </p>
                )}
              </div>
            ) : null}

            {showControlledAfterHours ? (
              <div
                data-testid="controlled-group-after-hours"
                className="rounded-lg border border-amber-400/50 bg-amber-400/10 p-3"
              >
                <p className="text-sm font-semibold text-nq-foreground">
                  🌙 {tx.afterHoursTitle}
                </p>
                <p className="mt-1 text-xs leading-5 text-nq-muted">
                  {tx.afterHoursBody}
                </p>
                {!everyMemberHasSpecificStaff ? (
                  <p className="mt-2 text-xs font-medium text-amber-300">
                    {tx.afterHoursPickStaff}
                  </p>
                ) : (
                  <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs leading-5 text-nq-foreground">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 accent-nq-primary"
                      checked={afterHoursConsent}
                      onChange={(event) =>
                        setAfterHoursConsent(event.target.checked)
                      }
                    />
                    {tx.afterHoursConsent}
                  </label>
                )}
              </div>
            ) : null}

            {arrangements.length > 0 ? (
              <div>
                <p className={labelCls}>{tx.chooseArrangement}</p>
                <div className="space-y-2">
                  {arrangements.map((arr, idx) => {
                    const total = formatCurrency(
                      arr.totalCents,
                      data.salon.currencyCode,
                    );
                    return (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => setSelectedIdx(idx)}
                        className={`w-full rounded-lg border p-3 text-left transition ${
                          selectedIdx === idx
                            ? "border-nq-primary bg-nq-primary/10"
                            : "border-nq-muted/25 bg-nq-bg hover:border-nq-primary/50"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-nq-foreground">
                            {arr.groupStartDisplay}
                            {arr.isWaveBooking
                              ? ` · ${tx.waves(arr.waveCount)}`
                              : ""}
                          </span>
                          {total ? (
                            <span className="text-xs text-nq-muted">
                              {total}
                            </span>
                          ) : null}
                        </div>
                        <ul className="mt-1.5 space-y-0.5">
                          {arr.assignments
                            .slice()
                            .sort((a, b) => a.memberIndex - b.memberIndex)
                            .map((a) => (
                              <li
                                key={a.memberIndex}
                                className="text-[11px] text-nq-muted"
                              >
                                {a.memberName || tx.member(a.memberIndex + 1)} ·{" "}
                                {a.startDisplay} · {a.staffName}
                              </li>
                            ))}
                        </ul>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {error ? <p className="text-xs text-nq-error">{error}</p> : null}

            {arrangements.length > 0 || showControlledAfterHours ? (
              <button
                type="button"
                disabled={
                  submitting ||
                  digits.length < 10 ||
                  (showControlledAfterHours &&
                    (!everyMemberHasSpecificStaff || !afterHoursConsent))
                }
                onClick={() => void createGroup()}
                className="w-full rounded-md bg-nq-primary py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {submitting
                  ? tx.creating
                  : showControlledAfterHours
                    ? tx.createAfterHoursGroup
                    : tx.createGroup}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
