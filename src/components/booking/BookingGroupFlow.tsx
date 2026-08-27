"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import { addonLabel } from "@/shared/booking/serviceLabels";
import { isValidCustomerName } from "@/shared/lib/nameFormat";
import type {
  BookingSalonMeta,
  BookingStaffItem,
} from "@/shared/booking/loadBookingServices";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import {
  loadGroupSmartSchedule,
  type GroupAlternatives,
  type GroupArrangement,
  type GroupArrivalPreference,
  type GroupSmartScheduleResult,
  type GroupSyncMode,
} from "@/shared/booking/loadGroupSmartSchedule";
import {
  submitGroupBooking,
  type GroupBookingMember,
  type GroupBookingResult,
} from "@/shared/booking/submitGroupBooking";
import { createPartyLink } from "@/shared/booking/partyLinkActions";
import { checkGroupSlotsAvailable } from "@/shared/booking/checkGroupSlotsAvailable";
import {
  buildCapabilityMap,
  filterStaffCapableForService,
} from "@/shared/booking/staffCapability";
import { BookingCalendarGrid } from "@/components/booking/BookingCalendarGrid";
import { BookingFlowOtpPanel } from "@/components/booking/BookingFlowOtpPanel";
import { BOOKING_STEP_EASE } from "@/components/booking/bookingMotion";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { GROUP_TOGETHER_THRESHOLD_MIN } from "@/shared/booking/groupSchedulerCore";
import { bookingDateYmdFromLocalDate } from "@/shared/booking/bookingConfirmLabels";
import { parseBookingClosedDateSet } from "@/shared/booking/parseBookingClosedDates";
import {
  parseOpeningHours,
  type DayKey,
  type OpeningHoursWeek,
} from "@/shared/dashboard/openingHoursDefaults";
import { formatCurrency } from "@/shared/lib/currencyFormat";
import {
  ConfirmStepCardCapture,
  type ConfirmStepCardHandle,
} from "./ConfirmStepCardCapture";
import {
  resolveNoShowCardRequirement,
  type NoShowCardRequirement,
} from "@/shared/noshow/resolveNoShowCardRequirement";
import { NoShowCardCapture } from "./NoShowCardCapture";
import {
  resolveSavedNoShowCard,
  type SavedNoShowCard,
} from "@/shared/noshow/resolveSavedNoShowCard";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";
import { formatPhoneInputProgressive } from "@/shared/lib/phoneFormat";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { formatInSalonTz, salonDateOffset } from "@/shared/lib/salonTime";
import {
  GROUP_ARRANGEMENT_STALE_MS,
  SESSION_WARNING_MS,
} from "@/shared/config/constants";
import { cn } from "@/shared/lib/cn";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import { Button } from "@/components/ui/Button";
import { QRCodeSVG } from "qrcode.react";
import type { ReturningCustomer } from "@/components/booking/useBookingFlowState";
import {
  groupBookingPricingIntentKey,
  groupBookingQuoteMatchesRequest,
  groupBookingIdempotencyForIntent,
  resetGroupBookingIdempotency,
  parseGroupBookingPricingQuote,
  type GroupBookingPricingQuote,
  type GroupBookingPricingRequest,
} from "@/shared/booking/groupBookingPricing";
import { useBookingFunnelAnalytics } from "@/shared/analytics/useBookingFunnelAnalytics";
import { v1AllowsCustomerPaymentGateway } from "@/shared/release/v1IntegrationScope";

const CUSTOMER_PAYMENT_GATEWAY_ENABLED = v1AllowsCustomerPaymentGateway();

/**
 * Group booking — AI Arrival-First redesign (May 2026).
 *
 * Replaces the previous "shared date + shared time + per-member
 * service/staff" model with a 5-step arrival-first flow. The earlier
 * model forced the customer to guess a time that worked for the
 * whole group; the AI flow asks for an arrival *window* (morning /
 * afternoon / evening / specific) and lets the scheduler propose 3
 * arrangements based on real-time staff availability.
 *
 *   STEP 1  Number of people     — pill selector 2…maxGroupSize
 *   STEP 2  Service & Staff      — per-member: name + service +
 *                                  preferred staff (or "Any")
 *   STEP 3  Date & Arrival window — date + 4 arrival pills
 *                                  ("Morning / Afternoon / Evening /
 *                                  Specific time"); specific reveals
 *                                  a native time input
 *   STEP 4  AI Arrangement        — 3 option cards from
 *                                  `loadGroupSmartSchedule`:
 *                                  Best ✨ · Alternative · Earliest
 *   STEP 5  Confirm               — summary + contact + submit
 *
 * State is hoisted to this component so back-navigation preserves
 * everything the user already entered. The stepper at the top is the
 * single source of navigation truth — clicking earlier steps jumps
 * back (and clears arrangement results, which depend on data the
 * user is about to re-pick).
 *
 * Reuses (NEVER reimplements):
 *   - `loadGroupSmartSchedule` for the AI core (server action;
 *     ultimately reuses `salonTime`, `conflictCheck`-equivalent
 *     overlap, `staffCapability`).
 *   - `submitGroupBooking` for the final atomic write. The chosen
 *     arrangement's per-member start times are passed straight
 *     through (each member is treated as a normal group booking row
 *     by the existing RPC).
 */

const ARRIVAL_PRESETS: ReadonlyArray<
  Exclude<GroupArrivalPreference, { kind: "specific" }>["kind"]
> = ["morning", "afternoon", "evening"];

/** Time-of-day bucket for "now" in the salon's timezone, so the arrival window
 *  pre-focuses the period the customer is most likely thinking of (open at 11am
 *  → Morning; at 12–5 → Afternoon; after 5 → Evening). */
function currentArrivalPeriod(
  tz: string,
): Exclude<GroupArrivalPreference, { kind: "specific" }>["kind"] {
  let h = 12;
  try {
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone: tz || "America/Los_Angeles",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date())
      .find((p) => p.type === "hour");
    h = Number(part?.value ?? "12");
  } catch {
    /* fall back to noon */
  }
  if (!Number.isFinite(h)) h = 12;
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}

/**
 * Sensible starting value for the "Specific time" field: the current
 * salon-local time rounded up to the next 15 minutes, clamped into that day's
 * open hours. Falls back to 9:00–19:00 when the day has no usable hours.
 */
function defaultSpecificTime(
  tz: string,
  dayHours: { open?: string; close?: string; closed?: boolean } | null | undefined,
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz || "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "12");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  let mins = Math.ceil((h * 60 + m) / 15) * 15;
  const toMin = (s?: string): number | null => {
    const [hh, mm] = (s ?? "").split(":").map(Number);
    return Number.isFinite(hh) ? hh * 60 + (mm || 0) : null;
  };
  const open = (!dayHours?.closed ? toMin(dayHours?.open) : null) ?? 9 * 60;
  const close = (!dayHours?.closed ? toMin(dayHours?.close) : null) ?? 19 * 60;
  if (mins < open || mins >= close) mins = open;
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

type Step = 1 | 2 | 3 | 4 | 5 | "success";

type MemberDraft = {
  name: string;
  serviceId: string;
  /** `null` = "Any available". String UUID = explicit pick. */
  preferredStaffId: string | null;
  /** Add-on service IDs selected for this member. */
  addonServiceIds: string[];
};

function blankMember(index = 0, guestLabel = "Guest"): MemberDraft {
  return { name: `${guestLabel} ${index + 1}`, serviceId: "", preferredStaffId: null, addonServiceIds: [] };
}

/**
 * FIX 18 (Task #04-A) — display-only group reference format.
 *
 * Old format: `groupId.slice(0,8).toUpperCase()` → `A3F2E4B1`.
 *   Opaque to anyone reading it; receptionists couldn't tell which
 *   day the group was booked for, and 8 hex chars across all groups
 *   collide every ~16 million entries.
 *
 * New format: `#GRP-YYYYMMDD-XXXX`.
 *   - `YYYYMMDD` is the booking date (salon-local YMD the user
 *     already picked — pulled from `date` state, no DB lookup).
 *   - `XXXX` is the first 4 hex chars of `group_id` (uppercased).
 *   - Display only — `group_id` UUID remains the canonical
 *     primary key in the DB. Nothing here changes write paths.
 *
 * Collision rate at the 4-char × per-day scope is 1 in 65,536
 * within a single day, which is well below realistic group volume
 * per salon. Salon-wide search/lookup still uses the full UUID.
 */
function formatGroupRef(groupId: string, dateYmd: string): string {
  const dateCompact = /^(\d{4})-(\d{2})-(\d{2})$/.test(dateYmd)
    ? dateYmd.replace(/-/g, "")
    : "00000000";
  const suffix = groupId.replace(/-/g, "").slice(0, 4).toUpperCase();
  return `#GRP-${dateCompact}-${suffix}`;
}

const DAY_KEY_BY_INDEX: readonly DayKey[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];
function dayKeyForYmd(ymd: string): DayKey | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const idx = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
  ).getUTCDay();
  return DAY_KEY_BY_INDEX[idx] ?? null;
}

type BookingGroupFlowProps = {
  t: BookingMessages;
  shopSlug: string;
  services: readonly BookingServiceItem[];
  /** Add-on services available for per-guest selection. */
  addOns: readonly BookingServiceItem[];
  staff: readonly BookingStaffItem[];
  salon: BookingSalonMeta;
  /** `Math.min(activeStaffCount, HARD_GROUP_CAP)` — drives the
   *  size pill grid. The DB function allows up to 8; this is a
   *  UX cap, not a security check. */
  maxGroupSize: number;
  /** Optional staff capability rows for the salon. Threaded
   *  through so step 2's staff dropdown can filter by service. */
  capabilityRows?: { staff_id: string; service_id: string }[] | null;
  /** Phone-first entry — captured at the type-switcher gate. Pre-fills
   *  the primary-contact phone + organizer recognition. */
  initialPhone?: string;
  initialOrganizer?: ReturningCustomer | null;
  /** Name captured at the gate → pre-fills Guest 1. */
  initialName?: string;
  /** SMS consent captured at the phone gate → pre-satisfies the group confirm
   *  so the customer doesn't tick the SAME consent twice. */
  initialSmsConsent?: boolean;
  /** Marketing consent opt-in from the gate checkbox. */
  initialMarketingConsent?: boolean;
  /** OTP session already verified at the phone gate (gate-first OTP). Threaded
   *  in so an OTP-on organizer is NOT re-prompted for a second code after
   *  Confirm — mirrors the individual flow's initialOtpSessionId (#763). */
  initialOtpSessionId?: string | null;
  /** Booking-surface language → carried into the shared Party Link URL. */
  language?: "en" | "vi";
};

export function BookingGroupFlow({
  t,
  shopSlug,
  services,
  addOns,
  staff,
  salon,
  maxGroupSize,
  capabilityRows,
  initialPhone = "",
  initialOrganizer = null,
  initialName = "",
  initialSmsConsent = false,
  initialMarketingConsent: _initialMarketingConsent = false,
  initialOtpSessionId = null,
  language = "vi",
}: BookingGroupFlowProps) {
  const router = useRouter();
  const pathname = usePathname();

  // ── Wizard state (hoisted; preserves on back-nav) ──────────────
  const [step, setStep] = useState<Step>(1);
  const [size, setSize] = useState(2);
  const [members, setMembers] = useState<MemberDraft[]>(() => {
    const lbl = t?.groupBooking?.groupGuestLabel ?? "Guest";
    const m0 = blankMember(0, lbl);
    // Pre-fill Guest 1 with the gate-captured name (returning or new).
    if (initialName.trim()) m0.name = initialName.trim();
    return [m0, blankMember(1, lbl)];
  });
  /** The service last applied via the step-2 "same service for
   *  everyone" quick-fill. Used only to badge members who later
   *  override it ("Changed"). "" = quick-fill never used. */
  const [appliedServiceId, setAppliedServiceId] = useState("");
  /** Couple/group "sit next to each other" preference. Defaults ON —
   *  most groups (couples, friends, family) want to be seated
   *  together; for head-spa tenants this signals reception to set up
   *  two adjacent beds + a shared curtain. Persisted on every member
   *  row; surfaced as a 💕 badge on the receptionist board. */
  const [seatTogether, setSeatTogether] = useState(true);
  const [date, setDate] = useState("");
  /** Phase 1 sync mode: arrive together (default) or finish together. */
  const [syncMode, setSyncMode] = useState<GroupSyncMode>("sync_start");
  /** Target finish time HH:MM (24h, salon-local) — only used when
   *  syncMode === "sync_finish". */
  const [finishTime, setFinishTime] = useState("");
  // Pre-focus the arrival window on the period matching the current salon-local
  // time (open at 11am → Morning, 12pm → Afternoon, …) so the customer's most
  // likely choice is already selected.
  const nowArrivalPeriod = useMemo(
    () => currentArrivalPeriod(salon.timezone),
    [salon.timezone],
  );
  const [arrivalKind, setArrivalKind] = useState<
    GroupArrivalPreference["kind"]
  >(() => currentArrivalPeriod(salon.timezone));
  const [specificTime, setSpecificTime] = useState("");
  // Phone-first: pre-fill from the type-switcher gate when provided.
  const [primaryPhone, setPrimaryPhone] = useState(initialPhone ?? "");
  const [primaryEmail, setPrimaryEmail] = useState(
    initialOrganizer?.email ?? "",
  );

  // Voucher applied to the whole-party total (tied to the organizer phone).
  // Mirrors the individual flow's appliedVoucher; feeds submitGroupBooking.
  const [voucherCode, setVoucherCode] = useState<string | null>(null);
  const [pricingQuote, setPricingQuote] = useState<GroupBookingPricingQuote | null>(null);
  const [pricingQuoteKey, setPricingQuoteKey] = useState<string | null>(null);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [pricingError, setPricingError] = useState<string | null>(null);

  // Organizer recognition — when the primary-contact phone is valid we
  // look the customer up (same `/api/customer/[phone]` endpoint the
  // individual flow uses) and greet returning guests by name + VIP +
  // their usual service. `null` = unknown / new customer.
  const [organizer, setOrganizer] = useState<ReturningCustomer | null>(
    initialOrganizer ?? null,
  );
  const [organizerLoading, setOrganizerLoading] = useState(false);
  const organizerLookupTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Is the organizer (primary contact) also one of the guests getting a
  // service? Default true (couples/friends usually are). When true their
  // own slot is pre-claimed in the Party Link so the share link never
  // asks them to claim themselves; when false (booking on behalf) every
  // slot stays claimable.
  const [organizerIsGuest, setOrganizerIsGuest] = useState(true);

  // Smart-schedule results.
  const [scheduling, setScheduling] = useState(false);
  const [scheduleResult, setScheduleResult] =
    useState<GroupSmartScheduleResult | null>(null);
  const [selectedArrangementIdx, setSelectedArrangementIdx] = useState(0);
  // QA bug (2026-05-12, GB-3): staged loading phase for step 4.
  // The scheduler can take 5–15s on a cold cache + heavy day.
  // `normal` → friendly progress, `still-working` → past 10s heads-
  // up, `timeout` → past 20s with a back-out CTA. Reset on every
  // new scheduling cycle in the useEffect below.
  const [latencyPhase, setLatencyPhase] = useState<
    "normal" | "still-working" | "timeout"
  >("normal");

  // Submit state.
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // OTP gate (anti-sabotage) — organizer phone verification when the salon has
  // phone_otp_enabled. otpPanelOpen shows the verify panel; otpSessionId carries
  // the proof into the re-submit.
  const [otpSessionId, setOtpSessionId] = useState<string | null>(initialOtpSessionId);
  const [otpPanelOpen, setOtpPanelOpen] = useState(false);
  // No-show card capture at CONFIRM (Option A — like the individual flow):
  // a new/risky organizer must leave a card BEFORE the group is created, not
  // after success. cardRequirement is resolved pre-booking by organizer phone.
  const [cardRequirement, setCardRequirement] =
    useState<NoShowCardRequirement | null>(null);
  const [cardRequirementLoading, setCardRequirementLoading] = useState(false);
  const [noShowConsent, setNoShowConsent] = useState(false);
  // Mirrors ConfirmStep's own consent checkbox so the submit payload carries the
  // box the organizer actually ticked, rather than a hardcoded `true`.
  const [smsConsentGiven, setSmsConsentGiven] = useState(initialSmsConsent);
  const cardRef = useRef<ConfirmStepCardHandle>(null);
  // Holds the tokenized card across a possible OTP round-trip (the card iframe
  // unmounts when the OTP panel replaces the confirm step).
  const cardTokenRef = useRef<string | null>(null);
  // Square buyer-verification token (SCA/AVS/CVV) paired with the card token.
  const cardVerificationRef = useRef<string | null>(null);
  const [successResult, setSuccessResult] = useState<{
    groupId: string;
    bookingIds: string[];
    pricing: GroupBookingPricingQuote;
    cardManagementToken: string | null;
  } | null>(null);
  /** Party Link URL — set asynchronously after submitGroupBooking succeeds. */
  const [partyLinkUrl, setPartyLinkUrl] = useState<string | null>(null);
  /** True when Party Link creation failed (non-blocking — booking is still confirmed). */
  const [partyLinkFailed, setPartyLinkFailed] = useState(false);

  // FIX 09 (Task #04-A) — idempotency key MUST be stable across
  // retries within the same browser session, otherwise a network
  // drop + retry path produces two distinct keys and the server
  // can no longer dedupe (`insert_group_bookings` UNIQUE on
  // `(salon_id, idempotency_key, staff_id, start_time_utc)`).
  // `useRef` initialised on first render gives us a per-mount key
  // that survives `runScheduler` re-runs, race-loss retries, and
  // any other in-flight retry path. Refreshing the page (full
  // remount) generates a new key, which is correct — that's a new
  // group attempt.
  const idempotencyKeyRef = useRef<{ intentKey: string | null; key: string }>({
    intentKey: null,
    key: crypto.randomUUID(),
  });

  // FIX 07 (Task #04-A) — double-tap guard. The `submitting`
  // state flag drives UI disabled, but mobile double-taps can
  // fire two `onClick` handlers within a single React frame
  // *before* the disabled state has rendered. The ref is read
  // synchronously inside the handler, so the second tap exits
  // immediately. Reset only on error so the user can retry; not
  // reset on success (which transitions to a different step).
  const submittingRef = useRef<boolean>(false);

  // FIX 03 (Task #04-A) — track when the user picked the
  // arrangement they're about to confirm. Step 5 banner uses this
  // age against `GROUP_ARRANGEMENT_STALE_MS` to warn that another
  // customer may have raced the slot during the user's hesitation.
  // `null` = no arrangement picked yet (still on steps 1–4).
  const [arrangementSelectedAt, setArrangementSelectedAt] = useState<
    number | null
  >(null);
  const [arrangementStale, setArrangementStale] = useState(false);
  const [staleAcknowledged, setStaleAcknowledged] = useState(false);

  // FIX 14 (Task #04-A) — session-idle warning. Fires when the
  // user has been on step 5 for `SESSION_WARNING_MS` without
  // confirming. Non-blocking; the booking still works after the
  // banner appears.
  const [sessionWarning, setSessionWarning] = useState(false);

  // Task #04-C FIX 01 — slot-just-taken banner on step 5. Shows
  // while the auto-rescheduler is running after a pre-submit
  // probe detected one of the user's slots was raced by another
  // booking. Cleared once the new scheduler results land.
  const [slotJustTaken, setSlotJustTaken] = useState(false);

  // Per-field error sets for the wizard step validations.
  const [stepErrors, setStepErrors] = useState<Set<string>>(() => new Set());

  useBookingFunnelAnalytics({
    flow: "group",
    step,
    submitting,
    hasError: errorMessage !== null,
  });

  const groupCopy = (t.groupBooking ?? {}) as NonNullable<
    BookingMessages["groupBooking"]
  >;

  // ── Derived ────────────────────────────────────────────────────
  const capability = useMemo(
    () => buildCapabilityMap(capabilityRows ?? null),
    [capabilityRows],
  );

  // Add-on lookup map for fast per-member price/time computation.
  const addonById = useMemo(
    () => new Map(addOns.map((a) => [a.id, a])),
    [addOns],
  );
  // Sequential add-on block minutes for a member (concurrent = +0 time).
  const memberAddedMinutes = (m: MemberDraft) =>
    m.addonServiceIds.reduce((s, id) => {
      const a = addonById.get(id);
      return s + (a && !a.addonConcurrent ? a.totalMinutes : 0);
    }, 0);
  // Total add-on price cents for a member.
  const memberAddonCents = (m: MemberDraft) =>
    m.addonServiceIds.reduce((s, id) => {
      const a = addonById.get(id);
      return s + (a?.priceCents ?? 0);
    }, 0);

  /** QA bug (2026-05-12): the *previous* native `<input type="date">`
   *  accepted typed-in years like 0513 on Chromium even when
   *  `min`/`max` were set — the constraint only fires for picker-
   *  driven selections. We replaced the input with a click-only
   *  visual calendar (`BookingCalendarGrid`, ≤90 days out), so the
   *  user can't enter a corrupt year through normal UX. This year
   *  check stays as a defense-in-depth gate in case a stale YMD
   *  reaches the wizard via back-nav or a future code path. */
  function isYearInRange(ymd: string): boolean {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    if (!m) return false;
    const year = Number(m[1]);
    return year >= 2024 && year <= 2030;
  }

  const openingWeek: OpeningHoursWeek | null = useMemo(
    () => parseOpeningHours(salon.opening_hours),
    [salon.opening_hours],
  );
  const dayHours = useMemo(() => {
    if (!openingWeek || !date) return null;
    const key = dayKeyForYmd(date);
    if (!key) return null;
    return openingWeek[key];
  }, [openingWeek, date]);
  const isSelectedDayClosed = !!dayHours?.closed;

  // Totals — sum of service prices + add-on prices; max member
  // effective duration (svc block + sequential add-on block).
  const totals = useMemo(() => {
    let cents = 0;
    let anyPriced = false;
    let maxMin = 0;
    for (const m of members) {
      const svc = services.find((s) => s.id === m.serviceId);
      if (!svc) continue;
      const addonCents = memberAddonCents(m);
      if (svc.priceCents != null || addonCents > 0) {
        anyPriced = true;
        cents += (svc.priceCents ?? 0) + addonCents;
      }
      const effectiveMin = svc.totalMinutes + memberAddedMinutes(m);
      if (effectiveMin > maxMin) maxMin = effectiveMin;
    }
    return { totalCents: anyPriced ? cents : null, maxMinutes: maxMin };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, services, addonById]);

  // QA bug — closed-date set for the visual calendar in step 3.
  // Owner-defined exceptions (holidays, one-off closures) get
  // surfaced as disabled cells in addition to the weekly opening-
  // hours gating that `BookingCalendarGrid` already handles.
  const closedDateYmdSet = useMemo(
    () => parseBookingClosedDateSet(salon.booking_closed_dates),
    [salon.booking_closed_dates],
  );

  const totalDisplay = useMemo(() => {
    if (totals.totalCents == null) return null;
    return formatCurrency(totals.totalCents, salon.currencyCode) ?? null;
  }, [totals.totalCents, salon.currencyCode]);

  const buildPricingRequest = useCallback(
    (nextVoucherCode: string | null): GroupBookingPricingRequest | null => {
      if (!scheduleResult || !scheduleResult.ok) return null;
      const arrangement = scheduleResult.arrangements[selectedArrangementIdx];
      const organizerPhone = validateGuestPhone(primaryPhone);
      const email = primaryEmail.trim().toLowerCase();
      if (!arrangement || !organizerPhone.ok || (email && !isValidEmailFormat(email))) {
        return null;
      }
      return {
        salonId: salon.id,
        bookings: arrangement.assignments
          .slice()
          .sort((a, b) => a.memberIndex - b.memberIndex)
          .map((assignment, index) => {
            const draft = members[assignment.memberIndex];
            return {
              serviceId: draft.serviceId,
              staffId: assignment.staffId,
              startTimeUtc: assignment.startUtcIso,
              endTimeUtc: assignment.endUtcIso,
              addonServiceIds: [...draft.addonServiceIds],
              clientName: draft.name.trim() || `Guest ${index + 1}`,
              clientPhone: index === 0 ? organizerPhone.digits : null,
              clientEmail: index === 0 && email ? email : null,
              clientNotes: null,
              staffRequestedByClient: draft.preferredStaffId !== null,
              waveNumber: assignment.waveNumber ?? 1,
              seatTogether,
              clientLocale: language,
              resourceId: null,
            };
          }),
        voucherCode: nextVoucherCode,
        applyEmailDiscount: Boolean(email),
      };
    }, [
      language,
      members,
      primaryEmail,
      primaryPhone,
      salon.id,
      scheduleResult,
      seatTogether,
      selectedArrangementIdx,
    ],
  );

  const pricingRequest = useMemo(
    () => buildPricingRequest(voucherCode),
    [buildPricingRequest, voucherCode],
  );
  const currentPricingKey = pricingRequest
    ? groupBookingPricingIntentKey(pricingRequest)
    : null;
  const pricingReady = Boolean(
    pricingRequest &&
    pricingQuote &&
    pricingQuoteKey === currentPricingKey &&
    groupBookingQuoteMatchesRequest(pricingQuote, pricingRequest),
  );
  const appliedVoucher = useMemo(
    () => pricingReady && voucherCode && pricingQuote?.voucherId
      ? {
          voucher_id: pricingQuote.voucherId,
          code: voucherCode,
          discount_cents: pricingQuote.voucherDiscountCents,
          final_price_cents: pricingQuote.totalCents,
        }
      : null,
    [pricingQuote, pricingReady, voucherCode],
  );

  const requestPricingQuote = useCallback(
    async (request: GroupBookingPricingRequest, signal?: AbortSignal) => {
      try {
        const response = await fetch("/api/booking/group-quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify({
            salonId: request.salonId,
            bookings: request.bookings,
            voucherCode: request.voucherCode ?? null,
            applyEmailDiscount: request.applyEmailDiscount,
          }),
        });
        const data = await response.json().catch(() => null) as Record<string, unknown> | null;
        if (!data || data.ok !== true) {
          return { quote: null, error: data?.code === "voucher_invalid" ? "invalid" : "generic" };
        }
        const quote = parseGroupBookingPricingQuote(data.quote, {
          voucherCode: request.voucherCode,
        });
        if (!quote || !groupBookingQuoteMatchesRequest(quote, request)) {
          return { quote: null, error: "generic" };
        }
        return { quote, error: null };
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        return { quote: null, error: "generic" };
      }
    },
    [],
  );

  /* eslint-disable react-hooks/set-state-in-effect -- quote invalidation/loading must be synchronous with the material intent */
  useEffect(() => {
    if (step !== 5 || !pricingRequest || !currentPricingKey) return;
    const controller = new AbortController();
    setPricingLoading(true);
    setPricingError(null);
    void requestPricingQuote(pricingRequest, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.quote) {
          setPricingQuote(null);
          setPricingQuoteKey(null);
          setPricingError(result.error);
          return;
        }
        setPricingQuote(result.quote);
        setPricingQuoteKey(currentPricingKey);
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setPricingLoading(false);
      });
    return () => controller.abort();
  }, [currentPricingKey, pricingRequest, requestPricingQuote, step]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Apply a voucher by requesting a complete authoritative re-quote.
  const handleApplyVoucher = useCallback(
    async (code: string, _totalCents: number): Promise<{ error?: string }> => {
      void _totalCents;
      const normalized = code.trim().toUpperCase();
      const request = buildPricingRequest(normalized);
      if (!request) return { error: "generic" };
      setPricingLoading(true);
      const result = await requestPricingQuote(request);
      setPricingLoading(false);
      if (!result.quote) return { error: result.error ?? "generic" };
      setVoucherCode(normalized);
      setPricingQuote(result.quote);
      setPricingQuoteKey(groupBookingPricingIntentKey(request));
      setPricingError(null);
      return {};
    },
    [buildPricingRequest, requestPricingQuote],
  );

  const handleRemoveVoucher = useCallback(() => {
    setVoucherCode(null);
    setPricingQuote(null);
    setPricingQuoteKey(null);
  }, []);

  // Auto-apply a code carried on the landing URL (/<slug>?code=CODE), e.g. from
  // a re-opt-in email. Fires once, on the confirm step, after the organizer
  // phone is valid and the total is known. A mismatch is silent — the party can
  // still book at full price.
  const autoVoucherTried = useRef(false);
  useEffect(() => {
    if (autoVoucherTried.current || appliedVoucher) return;
    if (step !== 5) return;
    if (totals.totalCents == null || totals.totalCents <= 0) return;
    if (!validateGuestPhone(primaryPhone).ok) return;
    const code =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("code")?.trim().toUpperCase()
        : null;
    if (!code) return;
    autoVoucherTried.current = true;
    const total = totals.totalCents;
    void Promise.resolve().then(() => handleApplyVoucher(code, total));
  }, [step, primaryPhone, totals.totalCents, appliedVoucher, handleApplyVoucher]);

  // Same staff twice → soft warning only (scheduler will stagger).
  const duplicateStaffIdx = useMemo(() => {
    const seen = new Map<string, number>();
    const dupes = new Set<number>();
    for (let i = 0; i < members.length; i++) {
      const sid = members[i].preferredStaffId;
      if (!sid) continue;
      if (seen.has(sid)) dupes.add(i);
      else seen.set(sid, i);
    }
    return dupes;
  }, [members]);

  const arrivalPref: GroupArrivalPreference = useMemo(() => {
    if (arrivalKind === "specific") {
      return { kind: "specific", time: specificTime };
    }
    return { kind: arrivalKind };
  }, [arrivalKind, specificTime]);

  // ── Organizer recognition (debounced phone lookup) ─────────────
  // Mirrors the individual flow's returning-customer lookup. On a
  // valid primary-contact phone we greet the organizer by name and,
  // when Guest 1 is still the default placeholder, auto-fill it.
  useEffect(() => {
    if (organizerLookupTimer.current) {
      clearTimeout(organizerLookupTimer.current);
      organizerLookupTimer.current = null;
    }
    const v = validateGuestPhone(primaryPhone.trim());
    if (!v.ok) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reactive reset when phone becomes invalid
      setOrganizer(null);
      setOrganizerLoading(false);
      return;
    }
    setOrganizerLoading(true);
    organizerLookupTimer.current = setTimeout(() => {
      void fetch(
        `/api/customer/${encodeURIComponent(v.digits)}?salon_id=${encodeURIComponent(salon.id)}`,
      )
        .then((r) => r.json() as Promise<ReturningCustomer | { found: false }>)
        .then((data) => {
          if (data.found) {
            setOrganizer(data as ReturningCustomer);
            // Auto-fill Guest 1's name only with a REAL name and only if
            // it's still the default "{label} 1" placeholder — never
            // overwrite a typed name, never fill an empty/placeholder.
            // Name is NOT returned by the public lookup (privacy fix S1), so
            // this no longer auto-fills Guest 1 from a phone alone. Guarded for
            // a future post-OTP fetch that could supply it.
            const recognizedName = ((data as ReturningCustomer).name ?? "").trim();
            const lbl = groupCopy?.groupGuestLabel ?? "Guest";
            const def0 = `${lbl} 1`;
            if (recognizedName) {
              setMembers((prev) => {
                if (prev.length === 0) return prev;
                const cur = prev[0].name.trim();
                if (cur !== "" && cur !== def0) return prev;
                const next = prev.slice();
                next[0] = { ...next[0], name: recognizedName };
                return next;
              });
            }
          } else {
            setOrganizer(null);
          }
        })
        .catch(() => setOrganizer(null))
        .finally(() => setOrganizerLoading(false));
    }, 400);
    return () => {
      if (organizerLookupTimer.current) {
        clearTimeout(organizerLookupTimer.current);
        organizerLookupTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryPhone, salon.id]);

  // Pre-booking no-show card requirement for the organizer (Option A). Resolved
  // at the confirm step from the organizer's phone + service, exactly like the
  // individual flow — drives the card-entry form shown BEFORE the group is
  // created.
  useEffect(() => {
    if (!CUSTOMER_PAYMENT_GATEWAY_ENABLED || step !== 5) {
      return;
    }
    const svcId = members[0]?.serviceId;
    const v = validateGuestPhone(primaryPhone.trim());
    if (!svcId || !v.ok) {
      // Deliberate reset when inputs go invalid — not a render-loop.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCardRequirement(null);
      setCardRequirementLoading(false);
      return;
    }
    let alive = true;
    setCardRequirementLoading(true);
    void resolveNoShowCardRequirement({
      salonId: salon.id,
      serviceId: svcId,
      clientPhone: v.digits,
      // Whole-party protection: the organizer's card fee covers every member's
      // service, so show the party total upfront (matches what's saved/charged).
      groupServiceIds: members
        .map((m) => m.serviceId)
        .filter((id): id is string => Boolean(id)),
    })
      .then((r) => {
        if (!alive) return;
        setCardRequirement(r);
        setCardRequirementLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setCardRequirement(null);
        setCardRequirementLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [step, primaryPhone, members, salon.id]);

  // ── Helpers ────────────────────────────────────────────────────
  function applySize(n: number) {
    const clamped = Math.max(2, Math.min(maxGroupSize, Math.round(n)));
    const lbl = groupCopy?.groupGuestLabel ?? "Guest";
    setSize(clamped);
    setMembers((prev) => {
      const next: MemberDraft[] = [];
      for (let i = 0; i < clamped; i++) {
        next.push(prev[i] ?? blankMember(i, lbl));
      }
      return next;
    });
    setStepErrors(new Set());
  }

  function patchMember(i: number, patch: Partial<MemberDraft>) {
    setMembers((prev) => {
      const next = prev.slice();
      next[i] = { ...next[i], ...patch };
      // If the service changed, drop a preferred staff who isn't
      // capable of the new service to avoid stale ghosts.
      if (patch.serviceId !== undefined && capability) {
        const sid = next[i].preferredStaffId;
        if (sid && !(capability.get(sid)?.has(patch.serviceId) ?? false)) {
          next[i] = { ...next[i], preferredStaffId: null };
        }
      }
      return next;
    });
    setStepErrors((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      next.delete(`m${i}.name`);
      next.delete(`m${i}.service`);
      return next;
    });
    setErrorMessage(null);
    // Member edits invalidate prior schedule results.
    setScheduleResult(null);
  }

  /** Quick-fill: apply one service to every member at once. Most
   *  groups (couples, friends, mother+daughter at a head spa) book
   *  the SAME service, so the common path is one tap here instead of
   *  N per-card picks. Each member can still override below — the
   *  per-card picker stays fully functional. Mirrors `patchMember`'s
   *  capability guard so a now-incompatible preferred staff is
   *  dropped per member rather than left as a stale ghost. */
  function applyServiceToAll(serviceId: string) {
    if (!serviceId) return;
    setAppliedServiceId(serviceId);
    setMembers((prev) =>
      prev.map((m) => {
        const next: MemberDraft = { ...m, serviceId };
        if (capability) {
          const sid = next.preferredStaffId;
          if (sid && !(capability.get(sid)?.has(serviceId) ?? false)) {
            next.preferredStaffId = null;
          }
        }
        return next;
      }),
    );
    setStepErrors(new Set());
    setErrorMessage(null);
    setScheduleResult(null);
  }

  /** Derived: the single service shared by ALL members, or "" when
   *  members differ (or any is still blank). Drives the quick-fill
   *  select's value and the "applied / mixed" status line. */
  const groupServiceId = useMemo(() => {
    if (members.length === 0) return "";
    const first = members[0].serviceId;
    if (!first) return "";
    return members.every((m) => m.serviceId === first) ? first : "";
  }, [members]);

  /** Toggle an add-on for the WHOLE group at once. If every member already
   *  has it → remove it from all; otherwise add it to all. Per-member chips
   *  still let a guest override afterwards. */
  function applyAddonToAll(addonId: string) {
    if (!addonId) return;
    setMembers((prev) => {
      const allHave =
        prev.length > 0 &&
        prev.every((m) => m.addonServiceIds.includes(addonId));
      return prev.map((m) => ({
        ...m,
        addonServiceIds: allHave
          ? m.addonServiceIds.filter((id) => id !== addonId)
          : Array.from(new Set([...m.addonServiceIds, addonId])),
      }));
    });
    setScheduleResult(null);
  }

  /** Add-on ids shared by EVERY member — drives the group-level chip
   *  "selected" state. */
  const groupAddonIds = useMemo(() => {
    if (members.length === 0) return new Set<string>();
    return new Set(
      members[0].addonServiceIds.filter((id) =>
        members.every((m) => m.addonServiceIds.includes(id)),
      ),
    );
  }, [members]);

  /** Move forward to the given step, validating the current one
   *  on the way. Back-navigation (step < current) skips validation
   *  so the user can always retreat. */
  function goToStep(target: Step) {
    if (typeof target === "number" && typeof step === "number" && target < step) {
      setStep(target);
      setStepErrors(new Set());
      setErrorMessage(null);
      return;
    }
    if (step === 1 && target !== 1) {
      // Step 1 has no fields to validate (size is already clamped).
      setStep(target);
      return;
    }
    if (step === 2 && target !== 2) {
      const errs = new Set<string>();
      members.forEach((m, i) => {
        // Name is optional — default Guest placeholder is used if empty.
        if (!m.serviceId) errs.add(`m${i}.service`);
      });
      if (errs.size > 0) {
        setStepErrors(errs);
        return;
      }
      setStepErrors(new Set());
      setStep(target);
      return;
    }
    if (step === 3 && target !== 3) {
      const errs = new Set<string>();
      if (date.length === 0) errs.add("date");
      // QA bug — block corrupt years (e.g. "0513") before the
      // scheduler ever sees them. The date input's `min`/`max`
      // catches picker selections but typed segments slip through
      // on Chromium.
      else if (!isYearInRange(date)) errs.add("date");
      if (isSelectedDayClosed) errs.add("closed");
      if (syncMode === "sync_finish") {
        // Finish-together mode: a target finish time is required.
        if (finishTime.length === 0) errs.add("finishTime");
      } else {
        // Arrive-together mode: specific arrival requires a time.
        if (arrivalKind === "specific" && specificTime.length === 0) {
          errs.add("time");
        }
      }
      if (errs.size > 0) {
        setStepErrors(errs);
        return;
      }
      setStepErrors(new Set());
      // Generate arrangements on the way into step 4.
      void runScheduler();
      setStep(target);
      return;
    }
    if (step === 4 && target !== 4) {
      if (
        !scheduleResult ||
        !scheduleResult.ok ||
        scheduleResult.arrangements.length === 0
      ) {
        return;
      }
      setStep(target);
      return;
    }
    if (step === 5 && target !== 5) {
      setStep(target);
      return;
    }
  }

  async function runScheduler() {
    // Last-line guard: never call the server with an out-of-range
    // year. Surface as an empty `no_slots` state because the UI
    // already renders that with a "Try another date" action and we
    // don't want a new error code just for this corner.
    if (!isYearInRange(date)) {
      // Task #05 — `no_slots` now also carries `timezone` +
      // `alternatives`. We have neither at this guard (we haven't
      // queried the salon), so emit empty alternatives and an
      // empty timezone string. The empty state copes with both.
      setScheduleResult({
        ok: false,
        reason: "no_slots",
        timezone: salon.timezone,
        alternatives: {
          splitOption: null,
          nextAvailableDate: null,
          earlierToday: null,
        },
      });
      setScheduling(false);
      return;
    }
    setScheduling(true);
    setScheduleResult(null);
    setSelectedArrangementIdx(0);
    // FIX 03 — clear stale-arrangement state on every new run.
    // The next selection re-stamps `arrangementSelectedAt` either
    // implicitly (auto-pick #0 below) or explicitly (user clicks
    // a card in step 4).
    setArrangementSelectedAt(null);
    setArrangementStale(false);
    setStaleAcknowledged(false);
    try {
      const res = await loadGroupSmartSchedule({
        shopSlug,
        date,
        arrivalPref,
        members: members.map((m) => ({
          name: m.name.trim(),
          serviceId: m.serviceId,
          preferredStaffId: m.preferredStaffId,
          addonServiceIds: m.addonServiceIds,
        })),
        // Phase 1: pass sync mode + finish time so the scheduler
        // can compute arrangements where everyone finishes together.
        mode: syncMode,
        finishTime: syncMode === "sync_finish" ? finishTime : undefined,
      });
      setScheduleResult(res);
      // Auto-pick first option = arrangement selection. Stamp the
      // time so the step-5 stale check has an anchor.
      if (res.ok && res.arrangements.length > 0) {
        setArrangementSelectedAt(Date.now());
      }
    } catch (e) {
      console.error("[BookingGroupFlow] scheduler failed", e);
      setScheduleResult({ ok: false, reason: "server_error" });
    } finally {
      setScheduling(false);
    }
  }

  async function onSubmit(otpOverride?: string) {
    // FIX 07 — synchronous double-tap guard. `submitting` state
    // would race a double-tap inside the same React frame; the ref
    // is read inline before any setState so the second tap exits
    // immediately. Reset only on error so the user can retry.
    if (submittingRef.current || submitting) return;
    submittingRef.current = true;
    if (
      !scheduleResult ||
      !scheduleResult.ok ||
      !scheduleResult.arrangements[selectedArrangementIdx]
    ) {
      submittingRef.current = false;
      return;
    }
    // P1 #18 — empty-state check first so the user gets the
    // "required" copy rather than the "invalid format" copy.
    if (primaryPhone.trim().length === 0) {
      setErrorMessage(groupCopy.phoneRequired ?? "Vui lòng nhập số điện thoại.");
      submittingRef.current = false;
      return;
    }
    // P1 #18 — format check before the server round-trip. Same
    // helper the server action uses (`validateGuestPhone`) so
    // client + server stay in lockstep.
    if (!validateGuestPhone(primaryPhone).ok) {
      setErrorMessage(
        groupCopy.contactInvalidPhone ??
          "Số điện thoại không hợp lệ.",
      );
      submittingRef.current = false;
      return;
    }
    // P1 #19 — email is optional, but if filled it must be valid.
    const emailTrim = primaryEmail.trim();
    if (emailTrim.length > 0 && !isValidEmailFormat(emailTrim)) {
      setErrorMessage(
        groupCopy.contactInvalidEmail ?? "Email không hợp lệ.",
      );
      submittingRef.current = false;
      return;
    }
    const submitPricingRequest = buildPricingRequest(voucherCode);
    const submitPricingKey = submitPricingRequest
      ? groupBookingPricingIntentKey(submitPricingRequest)
      : null;
    if (
      !submitPricingRequest ||
      !submitPricingKey ||
      !pricingQuote ||
      pricingQuoteKey !== submitPricingKey ||
      !groupBookingQuoteMatchesRequest(pricingQuote, submitPricingRequest)
    ) {
      setErrorMessage(
        pricingLoading
          ? "Refreshing the party total…"
          : "We couldn't verify the party total. Please review it and try again.",
      );
      submittingRef.current = false;
      return;
    }
    // Option A — capture the organizer's card BEFORE creating the group (only
    // when required). Tokenize once and hold it across a possible OTP round-trip
    // (the card iframe unmounts when the OTP panel replaces the confirm step).
    if (cardRequirement?.required && !cardTokenRef.current) {
      if (!noShowConsent) {
        // Safety net — the confirm button is already disabled until consent is
        // ticked, so this only fires on a programmatic submit.
        setErrorMessage(
          t.noShowCardError ??
            "Vui lòng đồng ý chính sách no-show để tiếp tục.",
        );
        submittingRef.current = false;
        return;
      }
      const result = await cardRef.current?.tokenize();
      if (!result) {
        submittingRef.current = false;
        return;
      }
      cardTokenRef.current = result.token;
      cardVerificationRef.current = result.verificationToken ?? null;
    }

    setErrorMessage(null);
    setSubmitting(true);
    try {
      const arr = scheduleResult.arrangements[selectedArrangementIdx];
      // Map per-member assignment → wall-clock HH:MM in salon tz.
      const payload: GroupBookingMember[] = arr.assignments
        .slice()
        .sort((a, b) => a.memberIndex - b.memberIndex)
        .map((a) => {
          const draft = members[a.memberIndex];
          // The scheduler returns UTC ISO; `submitGroupBooking`
          // expects salon-local "HH:MM" (24h). Convert via Intl in
          // the salon's tz so DST is correctly handled (e.g. spring-
          // forward day where wall-clock 02:30 doesn't exist).
          const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: salon.timezone,
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          }).formatToParts(new Date(a.startUtcIso));
          const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
          const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
          const time24 = `${hh}:${mm}`;
          const guestLbl = groupCopy?.groupGuestLabel ?? "Guest";
          // Identity Layer: ONLY the organizer (member 0) carries the contact
          // phone/email. Other guests have no contact of their own, so we send
          // an empty phone — the server marks them is_party_member instead of
          // copying the organizer's number onto their rows (the root cause of
          // one phone fanning out into dozens of mismatched names). They link
          // to a real profile later via the party-claim link.
          const isOrganizer = a.memberIndex === 0;
          return {
            name: draft.name.trim() || `${guestLbl} ${a.memberIndex + 1}`,
            phone: isOrganizer ? primaryPhone : "",
            email: isOrganizer ? primaryEmail.trim() || undefined : undefined,
            serviceId: draft.serviceId,
            staffId: a.staffId,
            staffRequestedByClient: draft.preferredStaffId !== null,
            date,
            time: time24,
            // Phase 6.1 — carry the wave so submit persists wave_number per row.
            waveNumber: a.waveNumber,
            // Add-on ids selected for this member.
            addonServiceIds: draft.addonServiceIds,
          };
        });

      idempotencyKeyRef.current = groupBookingIdempotencyForIntent(
        idempotencyKeyRef.current,
        submitPricingKey,
        crypto.randomUUID(),
      );
      const res: GroupBookingResult = await submitGroupBooking({
        shopSlug,
        members: payload,
        // The organizer's actual checkbox state — the confirm button is disabled
        // until it is ticked, but the payload must say so rather than assume it.
        smsConsent: smsConsentGiven || undefined,
        // Couple/group seating preference → 💕 badge for reception.
        seatTogether,
        // Language the organizer is booking in → confirmation SMS matches it.
        language,
        // OTP session (organizer phone) — required when the salon has
        // phone_otp_enabled. Override (passed straight from onVerified) wins
        // over state to avoid a stale-closure read on the retry.
        otpSessionId: otpOverride ?? otpSessionId,
        // Public group wizard → 'online' in the channel breakdown.
        bookingChannel: "online",
        // FIX 09 — stable key across retries. A network drop +
        // retry sends the same key; server's UNIQUE on
        // `(salon_id, idempotency_key, …)` returns
        // `duplicate_submission` instead of creating a second
        // group.
        idempotencyKey: idempotencyKeyRef.current.key,
        voucherCode,
        applyEmailDiscount: submitPricingRequest.applyEmailDiscount,
        expectedPricingQuote: pricingQuote,
        noShowCardSourceId: cardTokenRef.current,
        noShowCardVerificationToken: cardVerificationRef.current,
        noShowConsent,
      });
      if (res.ok) {
        if (!res.pricing) {
          setErrorMessage("We couldn't verify the saved party receipt. Please try again.");
          return;
        }
        setSuccessResult({
          groupId: res.groupId,
          bookingIds: res.bookingIds,
          pricing: res.pricing,
          cardManagementToken: res.cardManagementToken,
        });
        // Only an acknowledged success starts a new logical booking intent.
        idempotencyKeyRef.current = resetGroupBookingIdempotency(crypto.randomUUID());
        setStep("success");
        // No-show card for the organizer (lead = members[0], the only row with
        // a phone). Option A: a card captured at the confirm step is saved to
        // the lead now. CRITICAL — this must NOT silently fail: the booking is
        // already created, so a swallowed save error would leave a confirmed
        // group with no card and nobody the wiser. We AWAIT the save and, on any
        // failure, flag the lead so the desk collects the card manually (never a
        // silent loss). The flag endpoint is also the path when no card was
        // captured (not required → no-op).
        cardTokenRef.current = null;
        cardVerificationRef.current = null;
        // FIX 08 — drop the `?mode=group` query so a browser back
        // from the success panel lands on the clean booking home
        // rather than the filled-form mid-state. `router.replace`
        // (not push) so no extra history entry is created. The
        // success panel itself is still rendered from component
        // state — the URL change is purely a history-stack hygiene
        // tweak.
        router.replace(pathname);

        // Phase 2 — generate Party Link in the background so the
        // success panel can display the shareable URL.  Non-blocking:
        // if the call fails the success panel renders without the
        // link (no crash, no UX regression).
        const arrangement = scheduleResult?.arrangements[selectedArrangementIdx];
        if (arrangement) {
          const groupStartUtcIso = new Date(arrangement.groupStartMs).toISOString();
          createPartyLink({
            groupId: res.groupId,
            salonId: salon.id,
            bookingIds: res.bookingIds,
            mode: syncMode,
            groupStartUtcIso,
            baseUrl:
              typeof window !== "undefined" ? window.location.origin : "",
            organizerName:  members[0]?.name.trim() || undefined,
            organizerPhone: primaryPhone.trim() || undefined,
            language,
            // When the organizer is also a guest, member 0 is their slot
            // (payload is sorted by memberIndex, so bookingIds[0] = member
            // 0). Pre-claim it so the link never asks them to claim.
            organizerBookingId: organizerIsGuest
              ? (res.bookingIds[0] ?? null)
              : null,
          }).then((linkResult) => {
            if (linkResult.ok) {
              setPartyLinkUrl(linkResult.url);
            } else {
              if (process.env.NODE_ENV !== "production") {
                console.warn(
                  "[nailiq] createPartyLink returned ok:false — reason:",
                  linkResult.reason,
                  "\nIf reason is 'server_error', check that SUPABASE_SERVICE_ROLE_KEY is set in .env.local.",
                );
              }
              setPartyLinkFailed(true);
            }
          }).catch((err: unknown) => {
            if (process.env.NODE_ENV !== "production") {
              console.warn("[nailiq] createPartyLink threw unexpectedly:", err);
            }
            setPartyLinkFailed(true);
          });
        }
        return;
      }
      if (res.reason === "pricing_changed") {
        const request = buildPricingRequest(voucherCode);
        if (!request || !groupBookingQuoteMatchesRequest(res.pricing, request)) {
          setPricingQuote(null);
          setPricingQuoteKey(null);
          setErrorMessage("We couldn't verify the updated party total. Please try again.");
          return;
        }
        setPricingQuote(res.pricing);
        setPricingQuoteKey(groupBookingPricingIntentKey(request));
        setErrorMessage("The party total changed. Review the updated receipt, then confirm again.");
        return;
      }
      if (res.reason === "card_management_pending") {
        // The party may already be committed. Keep the current group key and
        // captured source/verification token so the next explicit Confirm
        // replays and reconciles the exact server operation.
        setErrorMessage(t.noShowCardError ?? "Card verification is still being completed. Please confirm again.");
        setStep(5);
        return;
      }
      if (res.reason === "otp_required" || res.reason === "otp_invalid") {
        // Salon requires phone OTP (anti-sabotage). Open the verify panel for
        // the organizer's number; on success we re-submit with the session id.
        if (res.reason === "otp_invalid") setOtpSessionId(null);
        setOtpPanelOpen(true);
        return;
      }
      if (res.reason === "slot_conflict") {
        // The arrangement we picked just got raced. Re-run the
        // scheduler so the user can pick a fresh option.
        // Task #04-C FIX 10 — copy now points the user at "another
        // group just took it" so the error message matches the
        // real-world cause (concurrent group at the same time).
        setErrorMessage(
          groupCopy.concurrentGroupTaken ??
            groupCopy.conflictExternal ??
            "Khung giờ vừa bị đặt mất. Đã tạo lại danh sách lựa chọn.",
        );
        await runScheduler();
        return;
      }
      // Task #04-C FIX 12 — staff was deleted/inactivated between
      // arrangement-pick and submit. Recoverable: re-run the
      // scheduler so the remaining members get fresh staff
      // suggestions. Banner shown briefly while the new schedule
      // loads; the empty-state path on step 4 handles the
      // "couldn't replace" case.
      if (res.reason === "staff_unavailable") {
        setErrorMessage(
          groupCopy.staffUnavailable ?? "Thợ không còn nhận lịch.",
        );
        await runScheduler();
        return;
      }
      // Task #04-C FIX 13 — service was soft-deleted between
      // step 2 and submit. Not recoverable from step 5 — the user
      // must re-pick a service. Bounce back to step 2 and
      // highlight the affected member's service field.
      if (res.reason === "service_unavailable") {
        const mi = typeof res.memberIndex === "number" ? res.memberIndex : 0;
        setStepErrors(new Set([`m${mi}.service`]));
        setErrorMessage(
          groupCopy.serviceUnavailable ??
            "Dịch vụ không còn được cung cấp.",
        );
        setStep(2);
        return;
      }
      if (res.reason === "past_date") {
        setErrorMessage(groupCopy.pastDate ?? "Không thể đặt lịch vào ngày đã qua.");
        return;
      }
      if (res.reason === "duplicate_submission") {
        setErrorMessage(groupCopy.duplicateSubmission);
        return;
      }
      if (res.reason === "salon_closed_day") {
        setErrorMessage(groupCopy.salonClosedDay);
        return;
      }
      if (res.reason === "salon_paused") {
        setErrorMessage(groupCopy.salonPaused);
        return;
      }
      if (res.reason === "invalid_group_size") {
        setErrorMessage(groupCopy.invalidGroupSize);
        return;
      }
      if (res.reason === "monthly_booking_limit_reached") {
        setErrorMessage(t.bookingErrors.monthlyLimitReached);
        return;
      }
      // P1 #20 — granular validation reasons. Each carries a 1-indexed
      // `memberNumber` so the copy can pinpoint the problem instead
      // of showing the generic "couldn't book the group" fallback.
      const mn = String("memberNumber" in res ? (res.memberNumber ?? 1) : 1);
      if (res.reason === "invalid_name") {
        setErrorMessage(
          (groupCopy.invalidNameForMember ??
            "Person {n}'s name is missing or invalid.").replace("{n}", mn),
        );
        return;
      }
      if (res.reason === "invalid_phone") {
        setErrorMessage(
          (groupCopy.invalidPhoneForMember ??
            "Person {n}'s phone isn't valid.").replace("{n}", mn),
        );
        return;
      }
      if (res.reason === "invalid_email") {
        setErrorMessage(
          (groupCopy.invalidEmailForMember ??
            "Person {n}'s email isn't valid.").replace("{n}", mn),
        );
        return;
      }
      if (res.reason === "invalid_time") {
        setErrorMessage(
          (groupCopy.invalidTimeForMember ??
            "Person {n}'s time is invalid.").replace("{n}", mn),
        );
        return;
      }
      if (res.reason === "invalid_date") {
        setErrorMessage(
          (groupCopy.invalidDateForMember ??
            "Person {n}'s date is invalid.").replace("{n}", mn),
        );
        return;
      }
      setErrorMessage(groupCopy.serverError);
    } finally {
      setSubmitting(false);
      // FIX 07 — release the double-tap guard so a legitimate
      // retry can proceed. Success path doesn't reach here because
      // it `return`s early; the guard stays held until the
      // component unmounts (correct — user shouldn't be able to
      // re-fire the SAME confirmed group).
      submittingRef.current = false;
    }
  }

  // Step 4 enters → kick the scheduler if results are missing
  // (e.g. user back-stepped to 3, didn't change anything, forward
  // again — we still want fresh data because availability moves).
  useEffect(() => {
    if (step === 4 && !scheduling && !scheduleResult) {
      void runScheduler();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // QA bug (2026-05-12, GB-3) — staged loading copy. Watch
  // `scheduling` and advance the phase at 10s + 20s. Always reset
  // to `normal` when scheduling flips false (result arrived or
  // user navigated away).
  /* eslint-disable react-hooks/set-state-in-effect -- intentional reset to normal before starting timers */
  useEffect(() => {
    if (!scheduling) {
      setLatencyPhase("normal");
      return;
    }
    setLatencyPhase("normal");
    const t10 = window.setTimeout(
      () => setLatencyPhase("still-working"),
      10_000,
    );
    const t20 = window.setTimeout(() => setLatencyPhase("timeout"), 20_000);
    return () => {
      window.clearTimeout(t10);
      window.clearTimeout(t20);
    };
  }, [scheduling]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // FIX 11 (Task #04-A) — clear cached arrangements when group
  // size changes. `applySize` mutates `members.length`; without
  // this effect a back-nav → resize → forward leaves the step-4
  // useEffect short-circuited (scheduleResult truthy) and the
  // user sees a stale N-arrangement set whose member count
  // doesn't match the new group size. First firing on mount is a
  // no-op (scheduleResult already null).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional clear when group size changes; avoids stale N-arrangement
    setScheduleResult(null);
  }, [members.length]);

  // FIX 03 (Task #04-A) — staleness timer for the arrangement
  // banner. Only active while the user is on step 5; otherwise
  // reset so re-entering step 5 (via back-nav) starts a fresh
  // countdown. If the arrangement was selected more than the
  // threshold ago when step 5 mounts, flag it immediately;
  // otherwise schedule a one-shot timer for the remaining window.
  useEffect(() => {
    if (step !== 5 || arrangementSelectedAt === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset when not on step 5
      setArrangementStale(false);
      return;
    }
    const elapsed = Date.now() - arrangementSelectedAt;
    if (elapsed >= GROUP_ARRANGEMENT_STALE_MS) {
      setArrangementStale(true);
      return;
    }
    const remaining = GROUP_ARRANGEMENT_STALE_MS - elapsed;
    const t = window.setTimeout(() => setArrangementStale(true), remaining);
    return () => window.clearTimeout(t);
  }, [step, arrangementSelectedAt]);

  // FIX 14 (Task #04-A) — session-idle warning on step 5. Reset
  // whenever the user enters or leaves step 5 so the banner
  // appears once per dwell, not as a persistent state across the
  // whole flow.
  /* eslint-disable react-hooks/set-state-in-effect -- intentional reset when leaving step 5 and before idle timer */
  useEffect(() => {
    if (step !== 5) {
      setSessionWarning(false);
      return;
    }
    setSessionWarning(false);
    const t = window.setTimeout(() => setSessionWarning(true), SESSION_WARNING_MS);
    return () => window.clearTimeout(t);
  }, [step]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Task #04-C FIX 01 — pre-submit slot availability probe. On
  // step 5 mount (or when the user picks a different arrangement
  // while on step 5), call the lightweight `check_group_slots_available`
  // RPC. If any slot raced, surface the banner + auto-rerun the
  // scheduler so the user lands on fresh options without ever
  // clicking Confirm.
  //
  // Effect intentionally re-fires when `selectedArrangementIdx` or
  // `arrangementSelectedAt` change so a user who back-navs to step
  // 4, picks a different card, then returns to step 5 also gets
  // the probe.
  useEffect(() => {
    if (step !== 5) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset when leaving step 5
      setSlotJustTaken(false);
      return;
    }
    if (
      !scheduleResult ||
      !scheduleResult.ok ||
      !scheduleResult.arrangements[selectedArrangementIdx]
    ) {
      return;
    }
    const arr = scheduleResult.arrangements[selectedArrangementIdx];
    let cancelled = false;
    void (async () => {
      const probe = await checkGroupSlotsAvailable(
        arr.assignments.map((a) => ({
          memberIndex: a.memberIndex,
          salonId: salon.id,
          staffId: a.staffId,
          startUtcIso: a.startUtcIso,
          endUtcIso: a.endUtcIso,
        })),
      );
      if (cancelled) return;
      // Soft-fail: a probe error doesn't block the user — the
      // GIST constraint at insert time will still catch the race.
      // Treat error like "no conflict known" and let the user
      // proceed.
      if ("error" in probe || probe.available === true) return;
      // At least one slot is gone. Surface the banner, then
      // re-run the scheduler. The scheduler call will set
      // scheduleResult fresh, which triggers a re-render and the
      // banner gets cleared by the next branch of this effect on
      // the new arrangement.
      setSlotJustTaken(true);
      await runScheduler();
      if (!cancelled) setSlotJustTaken(false);
    })();
    return () => {
      cancelled = true;
    };
    // `runScheduler` reads `date`/`arrivalPref`/`members`/`shopSlug`
    // from closure; not putting it in deps to avoid re-firing on
    // every input keystroke during step 5. The effect re-fires on
    // arrangement-selection change which is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, selectedArrangementIdx, arrangementSelectedAt, salon.id]);

  // ── Render ─────────────────────────────────────────────────────
  if (step === "success" && successResult) {
    return (
      <SuccessPanel
        groupCopy={groupCopy}
        t={t}
        successResult={successResult}
        members={members}
        services={services}
        scheduleResult={scheduleResult}
        selectedArrangementIdx={selectedArrangementIdx}
        date={date}
        showStaff={salon.staffSelectionEnabled !== false}
        seatTogether={seatTogether}
        partyLinkUrl={partyLinkUrl}
        partyLinkFailed={partyLinkFailed}
        currencyCode={salon.currencyCode}
        otpSessionId={otpSessionId}
        salonId={salon.id}
      />
    );
  }

  return (
    <section
      data-testid="booking-group-flow"
      className="mt-8 w-full"
      style={{ color: "var(--booking-text)" }}
    >
      <Stepper
        current={typeof step === "number" ? step : 5}
        labels={[
          groupCopy.groupStep1 ?? "Số người",
          groupCopy.groupStep2 ?? "Dịch vụ",
          groupCopy.groupStep3 ?? "Ngày & giờ",
          groupCopy.groupStep4 ?? "Sắp xếp",
          groupCopy.groupStep5 ?? "Xác nhận",
        ]}
        onJump={(n) => {
          if (n < (typeof step === "number" ? step : 5)) {
            goToStep(n as Step);
          }
        }}
      />

      {step === 1 ? (
        <SizeStep
          t={t}
          groupCopy={groupCopy}
          size={size}
          maxGroupSize={maxGroupSize}
          onApplySize={applySize}
          onNext={() => goToStep(2)}
        />
      ) : null}

      {step === 2 ? (
        <ServiceStaffStep
          t={t}
          groupCopy={groupCopy}
          members={members}
          services={services}
          addOns={addOns}
          staff={staff}
          capability={capability}
          showStaff={salon.staffSelectionEnabled !== false}
          duplicateStaffIdx={duplicateStaffIdx}
          stepErrors={stepErrors}
          totalDisplay={totalDisplay}
          maxMinutes={totals.maxMinutes}
          size={size}
          groupServiceId={groupServiceId}
          appliedServiceId={appliedServiceId}
          groupAddonIds={groupAddonIds}
          seatTogether={seatTogether}
          onSeatTogetherChange={setSeatTogether}
          onApplyServiceToAll={applyServiceToAll}
          onApplyAddonToAll={applyAddonToAll}
          onPatchMember={patchMember}
          onBack={() => goToStep(1)}
          onNext={() => goToStep(3)}
        />
      ) : null}

      {step === 3 ? (
        <DateArrivalStep
          t={t}
          groupCopy={groupCopy}
          date={date}
          syncMode={syncMode}
          finishTime={finishTime}
          arrivalKind={arrivalKind}
          nowPeriod={nowArrivalPeriod}
          specificTime={specificTime}
          isSelectedDayClosed={isSelectedDayClosed}
          stepErrors={stepErrors}
          salonId={salon.id}
          salonTimezone={salon.timezone}
          openingHoursRaw={salon.opening_hours}
          closedDateYmdSet={closedDateYmdSet}
          staff={staff}
          serviceTotalMinutes={totals.maxMinutes}
          onDateChange={(v) => {
            setDate(v);
            setStepErrors(new Set());
            setScheduleResult(null);
          }}
          onSyncModeChange={(m) => {
            setSyncMode(m);
            setFinishTime(""); // reset finish time when mode changes
            setScheduleResult(null);
            setStepErrors(new Set());
          }}
          onFinishTimeChange={(v) => {
            setFinishTime(v);
            setScheduleResult(null);
            setStepErrors(new Set());
          }}
          onArrivalKindChange={(k) => {
            // Switching *into* "Specific time" seeds a sensible value so the
            // customer confirms or nudges it instead of facing an empty field.
            // Only on the transition, and only when nothing is there — anything
            // already typed, or intentionally cleared, survives.
            if (k === "specific" && arrivalKind !== "specific") {
              setSpecificTime((cur) =>
                cur !== "" ? cur : defaultSpecificTime(salon.timezone, dayHours),
              );
            }
            setArrivalKind(k);
            setStepErrors(new Set());
            setScheduleResult(null);
          }}
          onSpecificTimeChange={(v) => {
            setSpecificTime(v);
            setScheduleResult(null);
          }}
          onBack={() => goToStep(2)}
          onNext={() => goToStep(4)}
        />
      ) : null}

      {step === 4 ? (
        <ArrangementStep
          t={t}
          groupCopy={groupCopy}
          scheduling={scheduling}
          latencyPhase={latencyPhase}
          scheduleResult={scheduleResult}
          selectedIdx={selectedArrangementIdx}
          currencyCode={salon.currencyCode}
          date={date}
          timezone={salon.timezone}
          togetherThresholdMin={salon.groupTogetherThresholdMin}
          syncMode={syncMode}
          showStaff={salon.staffSelectionEnabled !== false}
          onSelect={(idx) => {
            setSelectedArrangementIdx(idx);
            // FIX 03 — explicit pick re-stamps the timestamp.
            // The user just made a fresh decision, so the staleness
            // clock should restart.
            setArrangementSelectedAt(Date.now());
            setArrangementStale(false);
            setStaleAcknowledged(false);
          }}
          onRetry={() => void runScheduler()}
          onBack={() => goToStep(3)}
          onNext={() => goToStep(5)}
          onPickDate={(ymd) => {
            setDate(ymd);
            // QA BUG-09: when this is the next-available CARD, its arrangement
            // is already computed — seed it straight into step 5 instead of
            // re-running the scheduler (which flashed a redundant spinner).
            // A quick-pick of an arbitrary date has no pre-built arrangement,
            // so that path still re-runs.
            const nextAlt =
              scheduleResult &&
              !scheduleResult.ok &&
              scheduleResult.reason === "no_slots"
                ? scheduleResult.alternatives.nextAvailableDate
                : null;
            if (nextAlt && nextAlt.date === ymd && nextAlt.arrangement) {
              setScheduleResult({
                ok: true,
                arrangements: [nextAlt.arrangement],
                timezone: salon.timezone,
              });
              setSelectedArrangementIdx(0);
              setArrangementSelectedAt(Date.now());
              setArrangementStale(false);
              setStaleAcknowledged(false);
              goToStep(5);
              return;
            }
            void runScheduler();
          }}
          onPickEarlier={(kind) => {
            setArrivalKind(kind);
            // QA BUG-09: the earlier-today card likewise carries its computed
            // arrangement — jump straight to step 5 instead of re-running.
            const earlierAlt =
              scheduleResult &&
              !scheduleResult.ok &&
              scheduleResult.reason === "no_slots"
                ? scheduleResult.alternatives.earlierToday
                : null;
            if (earlierAlt && earlierAlt.arrangement) {
              setScheduleResult({
                ok: true,
                arrangements: [earlierAlt.arrangement],
                timezone: salon.timezone,
              });
              setSelectedArrangementIdx(0);
              setArrangementSelectedAt(Date.now());
              setArrangementStale(false);
              setStaleAcknowledged(false);
              goToStep(5);
              return;
            }
            void runScheduler();
          }}
          onPickSplit={(split) => {
            // Task #05 — split-option card. The synthetic
            // arrangement is constructed from the split's
            // pre-built `assignments` (main members + late
            // member, sorted by memberIndex). We synthesize a
            // GroupArrangement-shaped object so the existing
            // step-5 confirm flow picks it up unchanged — the
            // submit payload mapper at line ~552 already reads
            // each assignment's `startUtcIso` per member, which
            // is exactly what makes split work without DB or
            // RPC changes.
            const startMsList = split.assignments.map((a) =>
              Date.parse(a.startUtcIso),
            );
            const endMsList = split.assignments.map((a) =>
              Date.parse(a.endUtcIso),
            );
            const groupStartMs = Math.min(...startMsList);
            const groupEndMs = Math.max(...endMsList);
            const spreadMinutes = Math.round(
              (Math.max(...startMsList) - groupStartMs) / 60_000,
            );
            // Reuse the late member's pre-formatted display
            // strings — they were computed in the salon tz by
            // the scheduler, so they're already correct.
            const startDisplay =
              split.assignments[0]?.startDisplay ?? "";
            const endDisplay =
              split.assignments[split.assignments.length - 1]?.endDisplay ?? "";
            let totalCents: number | null = 0;
            for (const a of split.assignments) {
              if (a.priceCents == null) {
                totalCents = null;
                break;
              }
              totalCents = (totalCents ?? 0) + a.priceCents;
            }
            const splitArrangement: GroupArrangement = {
              // We bucket split into the existing "alternative"
              // kind so no downstream type widening is needed.
              // The success screen renders per-assignment times
              // either way; the kind label is just a tag.
              kind: "alternative",
              groupStartMs,
              groupEndMs,
              groupStartDisplay: startDisplay,
              groupEndDisplay: endDisplay,
              spreadMinutes,
              totalCents,
              assignments: split.assignments,
              // Phase 6 fields — the existing web "smart split" is not a wave
              // booking; defaults keep the success screen rendering unchanged.
              isWaveBooking: false,
              waveCount: 1,
              waves: [
                {
                  waveNumber: 1,
                  startMs: groupStartMs,
                  endMs: groupEndMs,
                  startDisplay,
                  endDisplay,
                  memberCount: split.assignments.length,
                },
              ],
              summary: "",
            };
            setScheduleResult({
              ok: true,
              arrangements: [splitArrangement],
              timezone: salon.timezone,
            });
            setSelectedArrangementIdx(0);
            setArrangementSelectedAt(Date.now());
            setArrangementStale(false);
            setStaleAcknowledged(false);
            goToStep(5);
          }}
        />
      ) : null}

      {step === 5 && otpPanelOpen ? (
        <BookingFlowOtpPanel
          t={t}
          shopSlug={shopSlug}
          clientPhone={primaryPhone}
          stepDir={1}
          reducedMotion={false}
          stepTransition={{ duration: 0.18, ease: BOOKING_STEP_EASE }}
          isOptional={false}
          onVerified={(sessionId) => {
            setOtpSessionId(sessionId);
            setOtpPanelOpen(false);
            void onSubmit(sessionId);
          }}
          onBack={() => setOtpPanelOpen(false)}
        />
      ) : null}
      {step === 5 && !otpPanelOpen ? (
        <ConfirmStep
          t={t}
          groupCopy={groupCopy}
          arrangement={
            scheduleResult && scheduleResult.ok
              ? scheduleResult.arrangements[selectedArrangementIdx] ?? null
              : null
          }
          members={members}
          services={services}
          date={date}
          timezone={salon.timezone}
          showStaff={salon.staffSelectionEnabled !== false}
          primaryPhone={primaryPhone}
          primaryEmail={primaryEmail}
          organizer={organizer}
          organizerLoading={organizerLoading}
          organizerIsGuest={organizerIsGuest}
          onOrganizerIsGuestChange={setOrganizerIsGuest}
          submitting={submitting}
          errorMessage={errorMessage}
          totalDisplay={
            pricingReady && pricingQuote
              ? formatCurrency(pricingQuote.totalCents, pricingQuote.currency) ?? null
              : null
          }
          pricingQuote={pricingReady ? pricingQuote : null}
          pricingLoading={pricingLoading}
          pricingError={pricingError}
          maxMinutes={totals.maxMinutes}
          size={size}
          // P1 #18 / #19 (QA re-sweep 2026-05-12) — disable Confirm
          // until phone passes the same `validateGuestPhone` the
          // server uses (was a loose >=10-digit gate that could
          // accept invalid NANP and bounce off the submit handler).
          // Tightening here lets ConfirmStep show inline
          // aria-invalid feedback while typing without ever letting
          // the user "burn a click" on input that submit will reject.
          // Optional email still has to be format-valid when present
          // (empty is fine).
          contactReady={
            validateGuestPhone(primaryPhone).ok &&
            (primaryEmail.trim().length === 0 ||
              isValidEmailFormat(primaryEmail.trim()))
          }
          // FIX 03 — show stale-arrangement banner when the user's
          // selection is >3min old AND they haven't acknowledged
          // it yet. "Refresh" navigates back to step 4 (clearing
          // scheduleResult forces re-run on entry).
          showStaleArrangement={arrangementStale && !staleAcknowledged}
          onStaleAcknowledge={() => setStaleAcknowledged(true)}
          onStaleRefresh={() => {
            setScheduleResult(null);
            setArrangementSelectedAt(null);
            setArrangementStale(false);
            setStaleAcknowledged(false);
            setStep(4);
          }}
          // FIX 14 — non-blocking idle warning.
          showSessionWarning={sessionWarning}
          // Task #04-C FIX 01 — banner shown while the auto-
          // rescheduler is running because the pre-submit probe
          // caught a raced slot.
          showSlotJustTaken={slotJustTaken}
          onPhoneChange={(v) => setPrimaryPhone(formatPhoneInputProgressive(v))}
          onEmailChange={setPrimaryEmail}
          onBack={() => goToStep(4)}
          onSubmit={() => void onSubmit()}
          initialSmsConsent={initialSmsConsent}
          onSmsConsentChange={setSmsConsentGiven}
          salonName={salon.name}
          cardRequirement={cardRequirement}
          cardRequirementLoading={cardRequirementLoading}
          cardRef={cardRef}
          noShowConsent={noShowConsent}
          onNoShowConsentChange={setNoShowConsent}
          currencyCode={salon.currencyCode}
          baseTotalCents={totals.totalCents}
          appliedVoucher={appliedVoucher}
          onApplyVoucher={handleApplyVoucher}
          onRemoveVoucher={handleRemoveVoucher}
        />
      ) : null}
    </section>
  );
}

// ─── Stepper ────────────────────────────────────────────────────

function Stepper({
  current,
  labels,
  onJump,
}: {
  current: number;
  labels: readonly string[];
  onJump: (n: number) => void;
}) {
  return (
    <ol
      data-testid="group-stepper"
      aria-label="Group booking steps"
      className="mb-6 flex flex-wrap items-center gap-1.5 text-xs"
    >
      {labels.map((label, idx) => {
        const n = idx + 1;
        const isCurrent = n === current;
        const isPast = n < current;
        const isClickable = isPast;
        const Tag = isClickable ? "button" : "span";
        return (
          <li key={label} className="flex items-center gap-1.5">
            <Tag
              type={isClickable ? "button" : undefined}
              onClick={isClickable ? () => onJump(n) : undefined}
              aria-current={isCurrent ? "step" : undefined}
              data-testid={`group-step-${n}`}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-full px-2.5 font-semibold transition-colors",
                isCurrent
                  ? "bg-[var(--salon-primary)] text-[var(--booking-bg)]"
                  : isPast
                    ? "bg-[var(--booking-bg-card)] text-[var(--booking-text)] hover:bg-[var(--booking-bg-input)]"
                    : "bg-transparent text-[var(--booking-text-muted)]",
              )}
            >
              <span
                className={cn(
                  "flex h-4 w-4 items-center justify-center rounded-full text-[10px]",
                  isCurrent
                    ? "bg-[var(--booking-bg)] text-[var(--salon-primary)]"
                    : isPast
                      ? "bg-[var(--booking-bg-input)] text-[var(--booking-text-muted)]"
                      : "border border-[var(--booking-text-muted)]/40",
                )}
              >
                {n}
              </span>
              <span className="hidden sm:inline">{label}</span>
            </Tag>
            {idx < labels.length - 1 ? (
              <span
                aria-hidden
                className="h-px w-3 bg-[var(--booking-border)] sm:w-5"
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

// ─── STEP 1 — Number of people ──────────────────────────────────

function SizeStep({
  t,
  groupCopy,
  size,
  maxGroupSize,
  onApplySize,
  onNext,
}: {
  t: BookingMessages;
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  size: number;
  maxGroupSize: number;
  onApplySize: (n: number) => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-4" data-testid="group-step-size-panel">
      <h2 className="text-lg font-semibold sm:text-xl">{groupCopy.sizeHeading}</h2>
      <div
        className={cn(
          "grid gap-2",
          maxGroupSize <= 3
            ? "grid-cols-2"
            : maxGroupSize <= 4
              ? "grid-cols-3"
              : "grid-cols-4 sm:grid-cols-5",
        )}
        role="radiogroup"
        aria-label={groupCopy.sizeHeading}
      >
        {Array.from(
          { length: Math.max(0, maxGroupSize - 1) },
          (_, i) => i + 2,
        ).map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={size === n}
            data-testid={`group-size-${n}`}
            onClick={() => onApplySize(n)}
            className={cn(
              "min-h-11 rounded-xl border text-lg font-semibold transition-colors",
              size === n
                ? "border-[var(--salon-primary)] bg-[var(--salon-primary)] text-[var(--booking-bg)]"
                : "border-[var(--booking-border)] bg-[var(--booking-bg-input)]",
            )}
          >
            {n}
          </button>
        ))}
      </div>
      <p className="text-xs text-[var(--booking-text-muted)]">
        {(groupCopy.maxSizeHint ?? "Up to {n} people").replace(
          "{n}",
          String(maxGroupSize),
        )}
      </p>
      <div className="mt-6 flex justify-end">
        <LuxuryBookingCta onClick={onNext} data-testid="group-size-next">
          {t.next}
        </LuxuryBookingCta>
      </div>
    </div>
  );
}

// ─── STEP 2 — Service & Staff per member ────────────────────────

function ServiceStaffStep({
  t,
  groupCopy,
  members,
  services,
  addOns,
  staff,
  capability,
  showStaff,
  duplicateStaffIdx,
  stepErrors,
  totalDisplay,
  maxMinutes,
  size,
  groupServiceId,
  appliedServiceId,
  groupAddonIds,
  seatTogether,
  onSeatTogetherChange,
  onApplyServiceToAll,
  onApplyAddonToAll,
  onPatchMember,
  onBack,
  onNext,
}: {
  t: BookingMessages;
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  members: readonly MemberDraft[];
  services: readonly BookingServiceItem[];
  addOns: readonly BookingServiceItem[];
  staff: readonly BookingStaffItem[];
  capability: ReturnType<typeof buildCapabilityMap>;
  showStaff: boolean;
  duplicateStaffIdx: Set<number>;
  stepErrors: Set<string>;
  totalDisplay: string | null;
  maxMinutes: number;
  size: number;
  /** Service shared by all members, or "" when mixed/blank. */
  groupServiceId: string;
  /** Service applied via quick-fill; used to badge overrides. */
  appliedServiceId: string;
  /** Add-on ids currently shared by EVERY member (group-level chip state). */
  groupAddonIds: Set<string>;
  /** Couple/group "sit together" preference. */
  seatTogether: boolean;
  onSeatTogetherChange: (v: boolean) => void;
  onApplyServiceToAll: (serviceId: string) => void;
  onApplyAddonToAll: (addonId: string) => void;
  onPatchMember: (i: number, patch: Partial<MemberDraft>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  // Whether anyone has started picking — drives the "applied / mixed"
  // status line under the quick-fill select.
  const anyServicePicked = members.some((m) => m.serviceId);
  return (
    <div className="space-y-4 pb-32" data-testid="group-step-service-panel">
      <h2 className="text-lg font-semibold sm:text-xl">
        {groupCopy.reviewHeading}
      </h2>

      {/* Quick-fill: "same service for everyone" — the common path
          (couples / friends / family at a head spa usually book the
          same service). One tap fills all member cards; each card can
          still override below. Only shown when there's a real choice
          (2+ services AND 2+ members). */}
      {services.length > 1 && members.length > 1 ? (
        <div
          data-testid="group-same-service"
          className="rounded-2xl border border-[var(--salon-primary)]/40 bg-[var(--salon-primary)]/5 p-4 sm:p-5"
        >
          <label
            htmlFor="group-same-service-input"
            className="mb-1 block text-base font-semibold"
          >
            ✨ {groupCopy.sameServiceHeading ?? "Same service for everyone?"}
          </label>
          <p className="mb-2.5 text-xs text-[var(--booking-text-muted)]">
            {groupCopy.sameServiceHint ??
              "Pick once for the whole group — you can change anyone below."}
          </p>
          <select
            id="group-same-service-input"
            value={groupServiceId}
            onChange={(e) => onApplyServiceToAll(e.target.value)}
            className="nq-booking-field"
            data-testid="group-same-service-select"
            style={{
              color: groupServiceId
                ? "var(--booking-text)"
                : "var(--booking-text-muted)",
            }}
          >
            <option value="">
              — {groupCopy.sameServicePlaceholder ?? "Choose a service for the group"} —
            </option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.durationMinutes} {t.minuteSuffixShort}
                {s.priceDisplay ? ` · ${s.priceDisplay}` : ""}
              </option>
            ))}
          </select>
          {anyServicePicked ? (
            <p
              className="mt-2 text-xs font-medium text-[var(--booking-text-muted)]"
              data-testid="group-same-service-status"
            >
              {groupServiceId
                ? `✓ ${(groupCopy.sameServiceApplied ?? "Applied to all {n} guests").replace("{n}", String(size))}`
                : (groupCopy.sameServiceMixed ?? "Each guest has their own service")}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Add-ons for the whole group — one tap adds an add-on to every
          guest; each card can still toggle its own below. */}
      {addOns.length > 0 && members.length > 1 ? (
        <div
          data-testid="group-same-addons"
          className="rounded-2xl border border-[var(--salon-primary)]/40 bg-[var(--salon-primary)]/5 p-4 sm:p-5"
        >
          <p className="mb-1 text-base font-semibold">
            ✨ {groupCopy.sameAddonsHeading ?? "Add-ons for everyone"}
          </p>
          <p className="mb-2.5 text-xs text-[var(--booking-text-muted)]">
            {groupCopy.sameAddonsHint ??
              "Tap to add for the whole group — you can change anyone below."}
          </p>
          <div className="flex flex-wrap gap-2">
            {addOns.map((a) => {
              const selected = groupAddonIds.has(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  data-testid={`group-same-addon-${a.id}`}
                  aria-pressed={selected}
                  onClick={() => onApplyAddonToAll(a.id)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    selected
                      ? "border-[var(--salon-primary)] bg-[var(--salon-primary)]/10 text-[var(--booking-text)]"
                      : "border-[var(--booking-border)] bg-[var(--booking-bg-input)] text-[var(--booking-text-muted)]",
                  )}
                >
                  {addonLabel(a)}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {duplicateStaffIdx.size > 0 ? (
        <p
          role="status"
          data-testid="group-staff-conflict-note"
          className="rounded-xl border border-nq-warning/45 bg-nq-warning/10 px-3 py-2 text-xs"
        >
          {groupCopy.staffConflictNote ??
            "Two people have selected the same staff."}
        </p>
      ) : null}

      <div className="space-y-3">
        {members.map((m, i) => (
          <MemberCard
            key={i}
            index={i}
            t={t}
            groupCopy={groupCopy}
            member={m}
            services={services}
            addOns={addOns}
            staff={staff}
            capability={capability}
            showStaff={showStaff}
            isDuplicateStaff={duplicateStaffIdx.has(i)}
            nameError={false}
            serviceError={stepErrors.has(`m${i}.service`)}
            isCustomized={
              !!appliedServiceId &&
              !!m.serviceId &&
              m.serviceId !== appliedServiceId
            }
            onChange={(patch) => onPatchMember(i, patch)}
          />
        ))}
      </div>

      {/* Couple/group "sit next to each other" preference. Default ON
          — most groups want to be seated together; for head-spa
          tenants this tells reception to set up two adjacent beds +
          a shared curtain ("2 beds → 1 couple space"). */}
      <button
        type="button"
        role="switch"
        aria-checked={seatTogether}
        data-testid="group-seat-together"
        onClick={() => onSeatTogetherChange(!seatTogether)}
        className={cn(
          "flex w-full items-center gap-3 rounded-2xl border p-4 text-left transition-colors sm:p-5",
          seatTogether
            ? "border-[var(--salon-primary)]/50 bg-[var(--salon-primary)]/5"
            : "border-[var(--booking-border)] bg-[var(--booking-bg-card)]",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
            seatTogether
              ? "bg-[var(--salon-primary)]"
              : "bg-[var(--booking-border)]",
          )}
        >
          <span
            className={cn(
              "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
              seatTogether ? "translate-x-[22px]" : "translate-x-0.5",
            )}
          />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold">
            💕 {groupCopy.seatTogetherLabel ?? "Seat us next to each other"}
          </span>
          <span className="mt-0.5 block text-xs text-[var(--booking-text-muted)]">
            {groupCopy.seatTogetherHint ??
              "We'll arrange adjacent beds with a shared curtain when possible."}
          </span>
        </span>
      </button>

      {groupCopy.partyLinkMemberHint ? (
        <p className="text-xs text-[var(--booking-text-muted)]">
          {groupCopy.partyLinkMemberHint}
        </p>
      ) : null}

      <StickyFooter
        leftLabel={groupCopy.totalLabel ?? "Total"}
        leftValue={
          <span>
            {size} {groupCopy.peopleSuffix ?? "people"}
            {totalDisplay ? ` · ${totalDisplay}` : ""}
            {maxMinutes > 0 ? ` · ${maxMinutes} ${t.minuteSuffixShort}` : ""}
          </span>
        }
      >
        <Button
          type="button"
          variant="secondary"
          onClick={onBack}
          data-testid="group-back"
          className="nq-booking-glass h-11 min-h-11 shrink-0 border border-[var(--booking-border)] bg-transparent text-[var(--booking-text-muted)] shadow-none"
        >
          {t.back}
        </Button>
        <LuxuryBookingCta onClick={onNext} data-testid="group-service-next">
          {t.next}
        </LuxuryBookingCta>
      </StickyFooter>
    </div>
  );
}

function MemberCard({
  index,
  t,
  groupCopy,
  member,
  services,
  addOns,
  staff,
  capability,
  showStaff,
  isDuplicateStaff,
  nameError,
  serviceError,
  isCustomized,
  onChange,
}: {
  index: number;
  t: BookingMessages;
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  member: MemberDraft;
  services: readonly BookingServiceItem[];
  /** Add-on services available for per-guest toggle selection. */
  addOns: readonly BookingServiceItem[];
  staff: readonly BookingStaffItem[];
  capability: ReturnType<typeof buildCapabilityMap>;
  /** When false (salon hides staff selection) the per-guest staff picker is omitted. */
  showStaff: boolean;
  isDuplicateStaff: boolean;
  nameError: boolean;
  serviceError: boolean;
  /** True when this member's service differs from the group quick-fill. */
  isCustomized: boolean;
  onChange: (patch: Partial<MemberDraft>) => void;
}) {
  const eligibleStaff = useMemo(() => {
    if (!member.serviceId) return staff;
    return filterStaffCapableForService(staff, capability, member.serviceId);
  }, [staff, capability, member.serviceId]);

  // QA BUG-04/10 — validate the guest name on blur (the server already rejects
  // invalid names; this surfaces it inline instead of only at the final step).
  const [nameTouched, setNameTouched] = useState(false);
  const localNameInvalid =
    nameTouched &&
    member.name.trim().length > 0 &&
    !isValidCustomerName(member.name.trim());

  return (
    <div
      data-testid={`group-member-${index}`}
      className={cn(
        "rounded-2xl border bg-[var(--booking-bg-card)] p-4 sm:p-5",
        isDuplicateStaff
          ? "border-nq-warning/60 ring-1 ring-nq-warning/30"
          : "border-[var(--booking-border)]",
      )}
    >
      <h3 className="mb-3 flex items-center gap-2 text-base font-semibold">
        <span>{groupCopy.personLabel.replace("{n}", String(index + 1))}</span>
        {isCustomized ? (
          <span
            data-testid={`group-member-${index}-custom-badge`}
            className="rounded-full bg-[var(--salon-primary)]/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--salon-primary)]"
          >
            {groupCopy.memberCustomBadge ?? "Changed"}
          </span>
        ) : null}
      </h3>

      <div className="space-y-3">
        <div>
          <input
            id={`group-member-${index}-name-input`}
            type="text"
            autoComplete="name"
            placeholder={`${groupCopy.groupGuestLabel ?? "Guest"} ${index + 1}`}
            value={member.name}
            maxLength={100}
            onChange={(e) => onChange({ name: e.target.value })}
            onBlur={() => setNameTouched(true)}
            aria-invalid={localNameInvalid || Boolean(nameError) || undefined}
            className={cn(
              "nq-booking-field",
              member.name.trim().length > 0 &&
                "font-medium text-[var(--booking-text)]",
              (localNameInvalid || nameError) && "border-nq-error/60",
            )}
            data-testid={`group-member-${index}-name`}
          />
          {localNameInvalid ? (
            <p
              className="mt-1 text-xs text-nq-error"
              data-testid={`group-member-${index}-name-error`}
            >
              {t.bookingErrors.invalidNameChars}
            </p>
          ) : null}
        </div>

        <div>
          <select
            id={`group-member-${index}-service-input`}
            value={member.serviceId}
            aria-invalid={serviceError || undefined}
            onChange={(e) => onChange({ serviceId: e.target.value })}
            className={cn(
              "nq-booking-field",
              serviceError && "border-nq-error/50",
            )}
            data-testid={`group-member-${index}-service`}
            style={{
              color: member.serviceId
                ? "var(--booking-text)"
                : "var(--booking-text-muted)",
            }}
          >
            <option value="">— {t.breadcrumbServices} —</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.durationMinutes} {t.minuteSuffixShort}
                {s.priceDisplay ? ` · ${s.priceDisplay}` : ""}
              </option>
            ))}
          </select>
          {serviceError ? (
            <p role="alert" className="mt-1 text-xs text-nq-error">
              {t.bookingErrors.serviceRequired}
            </p>
          ) : null}
        </div>

        {showStaff ? (
        <div>
          <select
            id={`group-member-${index}-staff-input`}
            value={member.preferredStaffId ?? ""}
            onChange={(e) =>
              onChange({ preferredStaffId: e.target.value || null })
            }
            className="nq-booking-field"
            data-testid={`group-member-${index}-staff`}
            style={{
              color: member.preferredStaffId
                ? "var(--booking-text)"
                : "var(--booking-text-muted)",
            }}
          >
            <option value="">— {t.anyStaffOptionTitle} —</option>
            {eligibleStaff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {isDuplicateStaff ? (
            <p
              role="alert"
              className="mt-1 text-xs text-nq-warning"
              data-testid={`group-member-${index}-duplicate-staff`}
            >
              {groupCopy.staffConflictNote ??
                "Two people have selected the same staff."}
            </p>
          ) : null}
        </div>
        ) : null}

        {/* Per-guest add-on multi-toggle — only shown when add-ons exist. */}
        {addOns.length > 0 ? (
          <div data-testid={`group-member-${index}-addons`}>
            <p className="mb-1.5 text-xs font-semibold text-[var(--booking-text-muted)]">
              {groupCopy.addOnsLabel ?? "Add-ons"}
            </p>
            <div className="flex flex-wrap gap-2">
              {addOns.map((a) => {
                const selected = member.addonServiceIds.includes(a.id);
                const label = addonLabel(a);
                return (
                  <button
                    key={a.id}
                    type="button"
                    data-testid={`group-member-${index}-addon-${a.id}`}
                    aria-pressed={selected}
                    onClick={() => {
                      const next = selected
                        ? member.addonServiceIds.filter((id) => id !== a.id)
                        : [...member.addonServiceIds, a.id];
                      onChange({ addonServiceIds: next });
                    }}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                      selected
                        ? "border-[var(--salon-primary)] bg-[var(--salon-primary)]/10 text-[var(--booking-text)]"
                        : "border-[var(--booking-border)] bg-[var(--booking-bg-input)] text-[var(--booking-text-muted)]",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─── STEP 3 — Date & Arrival window ──────────────────────────────

function DateArrivalStep({
  t,
  groupCopy,
  date,
  syncMode,
  finishTime,
  arrivalKind,
  nowPeriod,
  specificTime,
  isSelectedDayClosed,
  stepErrors,
  salonId,
  salonTimezone,
  openingHoursRaw,
  closedDateYmdSet,
  staff,
  serviceTotalMinutes,
  onDateChange,
  onSyncModeChange,
  onFinishTimeChange,
  onArrivalKindChange,
  onSpecificTimeChange,
  onBack,
  onNext,
}: {
  t: BookingMessages;
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  date: string;
  /** Phase 1 sync mode — "sync_start" (arrive together) or
   *  "sync_finish" (finish together). */
  syncMode: GroupSyncMode;
  /** Salon-local HH:MM finish time; only relevant in sync_finish mode. */
  finishTime: string;
  arrivalKind: GroupArrivalPreference["kind"];
  nowPeriod: Exclude<GroupArrivalPreference, { kind: "specific" }>["kind"];
  specificTime: string;
  isSelectedDayClosed: boolean;
  stepErrors: Set<string>;
  salonId: string;
  salonTimezone: string;
  openingHoursRaw: unknown | null;
  closedDateYmdSet: ReadonlySet<string>;
  staff: readonly BookingStaffItem[];
  /** Longest selected service duration (drives per-cell slot dots).
   *  0 when no member has picked a service yet. */
  serviceTotalMinutes: number;
  onDateChange: (v: string) => void;
  onSyncModeChange: (m: GroupSyncMode) => void;
  onFinishTimeChange: (v: string) => void;
  onArrivalKindChange: (k: GroupArrivalPreference["kind"]) => void;
  onSpecificTimeChange: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  // YMD ↔ Date adapter for the shared calendar. The group flow
  // stores the date as YMD; `BookingCalendarGrid` works in local
  // Date. `null` when nothing's picked.
  const selectedDate = useMemo(() => {
    if (!date) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!m) return null;
    const d = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      12,
      0,
      0,
    );
    return Number.isNaN(d.getTime()) ? null : d;
  }, [date]);

  return (
    <div className="space-y-5 pb-32" data-testid="group-step-date-panel">
      <h2 className="text-lg font-semibold sm:text-xl">
        {t.stepDateHeading}
      </h2>
      {/* QA bug fix (2026-05-12): replaced the native `<input
          type="date">` with the same visual calendar the individual
          flow uses. Native inputs accepted typed-in years like 0513
          on Chromium even with `min`/`max` set; the calendar grid is
          click-only so corrupt YMDs can't reach the scheduler. */}
      <div
        // The container keeps the legacy testid so any test that
        // scopes to the date region still finds it; the actual
        // cells are addressed via `[data-testid="date-day"]` /
        // `date-today` (same as the individual flow).
        data-testid="group-date-input"
        aria-invalid={stepErrors.has("date") || undefined}
      >
        <BookingCalendarGrid
          t={t}
          salonId={salonId}
          salonTimezone={salonTimezone}
          openingHoursRaw={openingHoursRaw}
          closedDateYmdSet={closedDateYmdSet}
          staff={staff}
          // No bound staff in group flow — any-available drives the
          // per-cell slot-availability fetch.
          staffId={BOOKING_ANY_STAFF_ID}
          serviceTotalMinutes={serviceTotalMinutes}
          selectedDate={selectedDate}
          // QA spec (2026-05-12, follow-up): salons settled on a
          // 90-day forward window after beta feedback. Was 365 in
          // PR #149 (which was the original "wedding parties / 6+
          // months" ask) — narrowed back because a year out felt
          // overly distant in practice and added load to the slot-
          // availability fetch. Individual flow uses 60d; group
          // bumps to 90d for a small wedding-party buffer.
          windowDays={90}
          onSelectDate={(d) => onDateChange(bookingDateYmdFromLocalDate(d))}
        />
        {isSelectedDayClosed ? (
          <p
            role="alert"
            data-testid="group-date-closed"
            className="mt-2 rounded-lg border border-nq-warning/45 bg-nq-warning/10 px-3 py-2 text-xs font-semibold"
          >
            {groupCopy.schedulingClosed ??
              "Salon is closed on this date. Please pick another date."}
          </p>
        ) : null}
        {stepErrors.has("date") && !isSelectedDayClosed ? (
          <p role="alert" className="mt-1 text-xs text-nq-error">
            {groupCopy.sharedScheduleRequired ?? "Please pick a date."}
          </p>
        ) : null}
      </div>

      {/* ── Phase 1: sync-mode toggle ─────────────────────────────
          Placed before the arrival/finish inputs so the customer
          declares intent ("arrive together" vs "finish together")
          before picking a time. */}
      <fieldset data-testid="group-sync-mode">
        <legend className="mb-2 block text-base font-semibold">
          {groupCopy.syncModeQuestion ?? "How should your group plan together?"}
        </legend>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              {
                mode: "sync_start" as const,
                label: groupCopy.syncStart ?? "🚶 Arrive together",
                hint: groupCopy.syncStartHint ?? "Everyone starts around the same time",
                testid: "group-sync-start",
              },
              {
                mode: "sync_finish" as const,
                label: groupCopy.syncFinish ?? "🏁 Finish together",
                hint: groupCopy.syncFinishHint ?? "Everyone is done at the same time",
                testid: "group-sync-finish",
              },
            ] as const
          ).map(({ mode, label, hint, testid }) => {
            const active = syncMode === mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={testid}
                onClick={() => onSyncModeChange(mode)}
                className={cn(
                  "flex min-h-14 flex-col items-start rounded-xl border px-4 py-3 text-left text-sm font-medium transition-colors",
                  active
                    ? "border-[var(--salon-primary)] bg-[var(--salon-primary)]/10 text-[var(--booking-text)]"
                    : "border-[var(--booking-border)] bg-[var(--booking-bg-input)] text-[var(--booking-text-muted)]",
                )}
              >
                <span className="font-semibold">{label}</span>
                <span
                  className={cn(
                    "mt-0.5 text-xs",
                    active
                      ? "text-[var(--booking-text-muted)]"
                      : "text-[var(--booking-text-muted)]/70",
                  )}
                >
                  {hint}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* ── Finish-together: target finish time input ──────────── */}
      {syncMode === "sync_finish" ? (
        <div data-testid="group-finish-time-section">
          <label
            htmlFor="group-finish-time-input"
            className="mb-1 block text-base font-semibold"
          >
            {groupCopy.finishTimeLabel ?? "Finish by (target time)"}
          </label>
          {groupCopy.finishTimeHint ? (
            <p className="mb-2 text-xs text-[var(--booking-text-muted)]">
              {groupCopy.finishTimeHint}
            </p>
          ) : null}
          <input
            id="group-finish-time-input"
            type="time"
            step={900} // 15-min grid
            value={finishTime}
            aria-invalid={stepErrors.has("finishTime") || undefined}
            onChange={(e) => onFinishTimeChange(e.target.value)}
            className={cn(
              "nq-booking-field tabular-nums",
              stepErrors.has("finishTime") && "border-nq-error/50",
            )}
            data-testid="group-finish-time"
          />
          {stepErrors.has("finishTime") ? (
            <p role="alert" className="mt-1 text-xs text-nq-error">
              {groupCopy.finishTimeRequired ?? "Please set a target finish time."}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ── Arrive-together: arrival window pills ─────────────── */}
      {syncMode === "sync_start" ? (
        <fieldset>
          <legend className="mb-2 block text-base font-semibold">
            {groupCopy.arrivalQuestion ?? "When would you like to arrive?"}
          </legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {ARRIVAL_PRESETS.map((k) => {
              const label =
                k === "morning"
                  ? groupCopy.arrivalMorning ?? "Morning"
                  : k === "afternoon"
                    ? groupCopy.arrivalAfternoon ?? "Afternoon"
                    : groupCopy.arrivalEvening ?? "Evening";
              const emoji =
                k === "morning" ? "🌅" : k === "afternoon" ? "☀️" : "🌆";
              const active = arrivalKind === k;
              return (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-testid={`group-arrival-${k}`}
                  onClick={() => onArrivalKindChange(k)}
                  className={cn(
                    "min-h-12 rounded-xl border px-4 py-2 text-left text-sm font-medium transition-colors",
                    active
                      ? "border-[var(--salon-primary)] bg-[var(--salon-primary)]/10 text-[var(--booking-text)]"
                      : "border-[var(--booking-border)] bg-[var(--booking-bg-input)] text-[var(--booking-text-muted)]",
                  )}
                >
                  <span className="mr-2" aria-hidden>
                    {emoji}
                  </span>
                  {label}
                  {k === nowPeriod ? (
                    <span className="ml-2 inline-block rounded-full bg-[var(--salon-primary)]/15 px-2 py-0.5 text-[10px] font-semibold text-[var(--salon-primary)]">
                      🕐 {groupCopy.arrivalNow ?? "Now"}
                    </span>
                  ) : null}
                </button>
              );
            })}
            <button
              type="button"
              role="radio"
              aria-checked={arrivalKind === "specific"}
              data-testid="group-arrival-specific"
              onClick={() => onArrivalKindChange("specific")}
              className={cn(
                "min-h-12 rounded-xl border px-4 py-2 text-left text-sm font-medium transition-colors sm:col-span-2",
                arrivalKind === "specific"
                  ? "border-[var(--salon-primary)] bg-[var(--salon-primary)]/10 text-[var(--booking-text)]"
                  : "border-[var(--booking-border)] bg-[var(--booking-bg-input)] text-[var(--booking-text-muted)]",
              )}
            >
              <span className="mr-2" aria-hidden>
                🕐
              </span>
              {groupCopy.arrivalSpecific ?? "Specific time"}
            </button>
          </div>
          {arrivalKind === "specific" ? (
            <div className="mt-3">
              <input
                type="time"
                step={300}
                value={specificTime}
                aria-invalid={stepErrors.has("time") || undefined}
                onChange={(e) => onSpecificTimeChange(e.target.value)}
                className={cn(
                  "nq-booking-field tabular-nums",
                  stepErrors.has("time") && "border-nq-error/50",
                )}
                data-testid="group-specific-time"
              />
              {stepErrors.has("time") ? (
                <p role="alert" className="mt-1 text-xs text-nq-error">
                  {groupCopy.sharedScheduleRequired ?? "Please pick a time."}
                </p>
              ) : null}
            </div>
          ) : null}
        </fieldset>
      ) : null}

      <StickyFooter leftLabel={null} leftValue={null}>
        <Button
          type="button"
          variant="secondary"
          onClick={onBack}
          data-testid="group-back"
          className="nq-booking-glass h-11 min-h-11 shrink-0 border border-[var(--booking-border)] bg-transparent text-[var(--booking-text-muted)] shadow-none"
        >
          {t.back}
        </Button>
        <LuxuryBookingCta
          onClick={onNext}
          // Same pattern as the step-5 Confirm CTA (BUG 2): block
          // the click before it can fire instead of allowing a
          // click-then-error round-trip. Empty date OR a closed-day
          // selection both gate the user here. sync_finish also
          // requires a target finish time before proceeding.
          disabled={
            isSelectedDayClosed ||
            date.length === 0 ||
            (syncMode === "sync_finish" && finishTime.length === 0)
          }
          data-testid="group-date-next"
        >
          {t.next}
        </LuxuryBookingCta>
      </StickyFooter>
    </div>
  );
}

// ─── STEP 4 — AI Arrangement ─────────────────────────────────────

function ArrangementStep({
  t,
  groupCopy,
  scheduling,
  latencyPhase,
  scheduleResult,
  selectedIdx,
  currencyCode,
  date,
  timezone,
  togetherThresholdMin,
  syncMode,
  showStaff,
  onSelect,
  onRetry,
  onBack,
  onNext,
  onPickDate,
  onPickEarlier,
  onPickSplit,
}: {
  t: BookingMessages;
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  scheduling: boolean;
  /** Staged loading phase: `normal` (0–10s) → `still-working`
   *  (10–20s) → `timeout` (20s+). Driven from the parent by a
   *  `setTimeout` chain that resets when `scheduling` flips. */
  latencyPhase: "normal" | "still-working" | "timeout";
  scheduleResult: GroupSmartScheduleResult | null;
  selectedIdx: number;
  currencyCode: BookingSalonMeta["currencyCode"];
  /** FIX 06 — needed by EmptyState to avoid re-offering the
   *  date the user is already on as a quick-pick. */
  date: string;
  /** FIX 06 — quick-pick labels resolve to salon-local weekdays. */
  timezone: string;
  /** Per-salon togetherness threshold (minutes) for the partial-vs-all-together
   *  ordering. */
  togetherThresholdMin: number;
  /** Phase 1: sync mode, forwarded to ArrangementCard for label copy. */
  syncMode: GroupSyncMode;
  /** When false (salon hides staff selection) staff names are omitted. */
  showStaff: boolean;
  onSelect: (i: number) => void;
  onRetry: () => void;
  onBack: () => void;
  onNext: () => void;
  /** FIX 06 / Task #05 — invoked when the user taps a
   *  next-available-date card; parent sets `date` + re-runs. */
  onPickDate: (ymd: string) => void;
  /** Task #05 — earlier-today card. Parent flips the arrival
   *  pref to the opposite window + re-runs. `kind` is the new
   *  arrival pref kind ("morning" or "afternoon" — never
   *  "specific" because we don't surface "earlier than specific"). */
  onPickEarlier: (kind: "morning" | "afternoon" | "evening") => void;
  /** Task #05 — split-option card. Parent sets the synthetic
   *  arrangement into scheduleResult + jumps to step 5 so the
   *  existing confirm flow handles submission. */
  onPickSplit: (split: NonNullable<GroupAlternatives["splitOption"]>) => void;
}) {
  return (
    <div className="space-y-4 pb-32" data-testid="group-step-arrangement-panel">
      <h2 className="text-lg font-semibold sm:text-xl">
        {groupCopy.groupStep4 ?? "AI Arrangement"}
      </h2>

      {/* QA bug (2026-05-12, GB-3) — staged loading.
          - normal       (0–10s):   "✨ Finding the best arrangements..."
          - still-working (10–20s):  "Still working, please wait..."
          - timeout      (20s+):    Same panel as the empty-state, with
                                    a "Try another date" CTA that
                                    bounces the user back to step 3. */}
      {scheduling && latencyPhase !== "timeout" ? (
        <SchedulingLoading
          phase={latencyPhase}
          groupCopy={groupCopy}
        />
      ) : null}

      {scheduling && latencyPhase === "timeout" ? (
        <SchedulingTimeout groupCopy={groupCopy} onBack={onBack} />
      ) : null}

      {/* Phase 6.1 — sync_finish large group can't fit: suggest Arrive together. */}
      {!scheduling &&
      scheduleResult &&
      !scheduleResult.ok &&
      scheduleResult.reason === "no_slots" &&
      scheduleResult.largeGroupFinishUnsupported ? (
        <p
          data-testid="group-wave-finish-unsupported"
          className="rounded-xl bg-amber-400/10 p-3 text-sm text-amber-700"
        >
          {groupCopy.waveFinishUnsupported ??
            "Finish together is not available for this large group. Try Arrive together or another time."}
        </p>
      ) : null}

      {!scheduling && scheduleResult && !scheduleResult.ok ? (
        <EmptyState
          reason={scheduleResult.reason}
          groupCopy={groupCopy}
          date={date}
          timezone={timezone}
          togetherThresholdMin={togetherThresholdMin}
          /* Task #05 — pass alternatives when present so the
           * empty state can offer split / earlier-today /
           * next-date cards instead of dead-ending. */
          alternatives={
            scheduleResult.reason === "no_slots"
              ? scheduleResult.alternatives
              : null
          }
          onRetry={onRetry}
          onBack={onBack}
          onPickDate={onPickDate}
          onPickEarlier={onPickEarlier}
          onPickSplit={onPickSplit}
        />
      ) : null}

      {!scheduling && scheduleResult?.ok ? (
        <div className="space-y-3">
          {scheduleResult.arrangements.map((arr, idx) => (
            <ArrangementCard
              key={`${arr.kind}-${idx}`}
              t={t}
              groupCopy={groupCopy}
              arrangement={arr}
              currencyCode={currencyCode}
              selected={idx === selectedIdx}
              syncMode={syncMode}
              showStaff={showStaff}
              onSelect={() => onSelect(idx)}
            />
          ))}
        </div>
      ) : null}

      <StickyFooter leftLabel={null} leftValue={null}>
        <Button
          type="button"
          variant="secondary"
          onClick={onBack}
          data-testid="group-back"
          className="nq-booking-glass h-11 min-h-11 shrink-0 border border-[var(--booking-border)] bg-transparent text-[var(--booking-text-muted)] shadow-none"
        >
          {t.back}
        </Button>
        <LuxuryBookingCta
          onClick={onNext}
          disabled={
            !scheduleResult ||
            !scheduleResult.ok ||
            scheduleResult.arrangements.length === 0
          }
          data-testid="group-arrangement-next"
        >
          {t.next}
        </LuxuryBookingCta>
      </StickyFooter>
    </div>
  );
}

function ArrangementCard({
  t,
  groupCopy,
  arrangement,
  currencyCode,
  selected,
  syncMode,
  showStaff,
  onSelect,
}: {
  t: BookingMessages;
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  arrangement: GroupArrangement;
  currencyCode: BookingSalonMeta["currencyCode"];
  selected: boolean;
  /** When false (salon hides staff selection) the per-guest staff name is omitted. */
  showStaff: boolean;
  /** Phase 1: changes the heading copy for sync_finish mode. */
  syncMode: GroupSyncMode;
  onSelect: () => void;
}) {
  // Plain-language start-spread: the real gap between the first and last
  // member's start time. "within 15/30 min" was confusing — when everyone
  // starts at the SAME time it still read "within 15 min". Say it plainly.
  const startSpreadMin = (() => {
    const ts = arrangement.assignments
      .map((a) => Date.parse(a.startUtcIso))
      .filter((n) => Number.isFinite(n));
    if (ts.length < 2) return 0;
    return Math.round((Math.max(...ts) - Math.min(...ts)) / 60_000);
  })();
  const startQualifier =
    startSpreadMin <= 0
      ? groupCopy.schedulingTogether ?? "Everyone starts at the same time"
      : (groupCopy.schedulingWithinMin ?? "Starts spread over {n} min").replace(
          "{n}",
          String(startSpreadMin),
        );

  // In sync_finish mode all members end at the same time so the start-spread
  // qualifier is meaningless — use dedicated copy keys instead.
  // Phase 6.1 — wave (large-group split) gets its own heading + icon.
  const heading = arrangement.isWaveBooking
    ? (groupCopy.waveSplitLabel ?? "Split into {count} waves").replace(
        "{count}",
        String(arrangement.waveCount),
      )
    : syncMode === "sync_finish"
      ? arrangement.kind === "best"
        ? groupCopy.schedulingFinishBest ?? "On time ✨"
        : arrangement.kind === "alternative"
          ? groupCopy.schedulingFinishAlt ?? "Alternative time 🔄"
          : groupCopy.schedulingFinishEarly ?? "Earliest possible ⚡"
      : arrangement.kind === "earliest"
        ? groupCopy.schedulingEarly ?? "Earliest"
        // sync_start options are a TIME picker — lead with the start time so the
        // distinct choices (2:00 · 2:30 · 3:00) are scannable at a glance. Keep
        // the spread qualifier only when members are actually staggered.
        : startSpreadMin > 0
          ? `${arrangement.groupStartDisplay} · ${startQualifier}`
          : arrangement.groupStartDisplay;
  const icon = arrangement.isWaveBooking
    ? "🌊"
    : arrangement.kind === "best"
      ? "✨"
      : arrangement.kind === "alternative"
        ? "🔄"
        : "⚡";

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-testid={`group-arrangement-${arrangement.kind}`}
      className={cn(
        "block w-full rounded-2xl border p-4 text-left transition-colors sm:p-5",
        selected
          ? "border-[var(--salon-primary)] bg-[var(--salon-primary)]/5 shadow-[var(--shadow-nq-tile-selected)]"
          : "border-[var(--booking-border)] bg-[var(--booking-bg-card)] hover:border-[var(--booking-text-muted)]/40",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold">
          <span aria-hidden className="mr-1.5">
            {icon}
          </span>
          {heading}
        </span>
        {arrangement.kind === "best" ? (
          <span className="rounded-full bg-[var(--salon-primary)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--booking-bg)]">
            {groupCopy.schedulingRecommended ?? "Recommended"}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-[var(--booking-text-muted)]">
        {arrangement.groupStartDisplay} → {arrangement.groupEndDisplay}
      </p>
      {arrangement.isWaveBooking && (
        <div
          data-testid="group-wave-breakdown"
          className="mt-2 space-y-1 rounded-xl bg-[var(--booking-bg-input)] p-3"
        >
          {arrangement.waves.map((w) => (
            <p
              key={w.waveNumber}
              data-testid={`group-wave-${w.waveNumber}`}
              className="text-xs text-[var(--booking-text)]"
            >
              {(groupCopy.waveLineLabel ?? "Wave {n}: {count} guests at {time}")
                .replace("{n}", String(w.waveNumber))
                .replace("{count}", String(w.memberCount))
                .replace("{time}", w.startDisplay)}
            </p>
          ))}
        </div>
      )}
      <ul className="mt-3 space-y-1.5 text-sm">
        {arrangement.assignments.map((a) => (
          <li
            key={a.memberIndex}
            className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
          >
            <span className="font-medium">
              {a.memberName || `#${a.memberIndex + 1}`}
            </span>
            <span className="text-[var(--booking-text-muted)]">
              {a.startDisplay}
              {showStaff ? ` · ${a.staffName}` : ""} · {a.serviceName}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-[var(--booking-text-muted)]">
        {(groupCopy.schedulingFinish ?? "Finishes at {time}").replace(
          "{time}",
          arrangement.groupEndDisplay,
        )}
      </p>
      {/* Hide currency from the card if any member is unpriced. */}
      {arrangement.totalCents != null ? (
        <p className="mt-1 text-xs text-[var(--booking-text-muted)]">
          {t.summaryTotal}:{" "}
          {formatCurrency(arrangement.totalCents, currencyCode) ?? ""}
        </p>
      ) : null}
    </button>
  );
}

function SchedulingLoading({
  phase,
  groupCopy,
}: {
  phase: "normal" | "still-working";
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
}) {
  // Copy switches when we cross the 10s threshold so the user gets
  // an explicit "still working" reassurance instead of staring at
  // the same line forever.
  const copy =
    phase === "still-working"
      ? groupCopy.schedulingStillWorking ?? "Still working, please wait..."
      : groupCopy.schedulingSearching ??
        "✨ Finding the best arrangements...";
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="group-scheduling-loading"
      data-phase={phase}
      className="rounded-xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] px-4 py-8 text-center text-sm text-[var(--booking-text-muted)]"
    >
      {/* Simple CSS-only pulse — heavier motion would compete with
          the framer-motion step transitions. The dot trio
          telegraphs "in progress" at a glance. */}
      <div
        className="mx-auto mb-2 inline-flex items-center gap-1"
        aria-hidden
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--salon-primary)]" />
        <span
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--salon-primary)]"
          style={{ animationDelay: "150ms" }}
        />
        <span
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--salon-primary)]"
          style={{ animationDelay: "300ms" }}
        />
      </div>
      <p>{copy}</p>
    </div>
  );
}

function SchedulingTimeout({
  groupCopy,
  onBack,
}: {
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  onBack: () => void;
}) {
  return (
    <div
      role="alert"
      data-testid="group-scheduling-timeout"
      className="rounded-xl border border-nq-warning/45 bg-nq-warning/10 px-4 py-5 text-sm"
    >
      <p>
        {groupCopy.schedulingTimeout ??
          "Could not find arrangements. Try another date."}
      </p>
      <div className="mt-3 flex gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={onBack}
          className="h-9 min-h-9 rounded-full border border-[var(--booking-border)] bg-transparent px-3 text-xs"
        >
          {groupCopy.schedulingTryDate ?? "Try another date"}
        </Button>
      </div>
    </div>
  );
}

function EmptyState({
  reason,
  groupCopy,
  date,
  timezone,
  togetherThresholdMin,
  alternatives,
  onRetry,
  onBack,
  onPickDate,
  onPickEarlier,
  onPickSplit,
}: {
  reason: Exclude<GroupSmartScheduleResult, { ok: true }>["reason"];
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  /** Salon-local YMD of the currently-selected date — used by the
   *  next-date card to render "Tomorrow" vs an absolute weekday. */
  date: string;
  /** Salon IANA tz. */
  timezone: string;
  /** Per-salon togetherness threshold (minutes). */
  togetherThresholdMin: number;
  /** Task #05 — null when reason ≠ no_slots; otherwise the 3
   *  alternative records (any subset may itself be null when the
   *  corresponding sub-query timed out / found no candidate). */
  alternatives: GroupAlternatives | null;
  onRetry: () => void;
  onBack: () => void;
  onPickDate: (ymd: string) => void;
  onPickEarlier: (kind: "morning" | "afternoon" | "evening") => void;
  onPickSplit: (split: NonNullable<GroupAlternatives["splitOption"]>) => void;
}) {
  const isCapacityEmpty = reason === "no_slots";
  const fallbackCopy =
    reason === "salon_closed"
      ? groupCopy.schedulingClosed ??
        "Salon is closed on this date. Please pick another date."
      : isCapacityEmpty
        ? groupCopy.allStaffBooked ??
          groupCopy.schedulingNoSlots ??
          "All staff fully booked this day. Try another date or reduce group size."
        : reason === "salon_paused"
          ? groupCopy.salonPaused
          : reason === "timezone_not_set"
            ? groupCopy.timezoneNotSet ??
              "Salon timezone not configured. Please contact the salon."
            : groupCopy.serverError;

  // Task #05 — render the smart-alternatives panel when reason is
  // no_slots AND at least one sub-query found something. Otherwise
  // fall through to the legacy single-line empty copy + back/retry
  // pair (covers salon_closed / salon_paused / timezone_not_set /
  // server_error and the rare case where the salon truly has no
  // valid alternatives for the next 5 days).
  const hasAlternatives =
    isCapacityEmpty &&
    alternatives !== null &&
    (alternatives.splitOption !== null ||
      alternatives.nextAvailableDate !== null ||
      alternatives.earlierToday !== null);

  if (hasAlternatives && alternatives) {
    return (
      <AlternativesPanel
        alternatives={alternatives}
        groupCopy={groupCopy}
        date={date}
        timezone={timezone}
        togetherThresholdMin={togetherThresholdMin}
        onPickDate={onPickDate}
        onPickEarlier={onPickEarlier}
        onPickSplit={onPickSplit}
        onBack={onBack}
        onRetry={onRetry}
      />
    );
  }

  return (
    <div
      role="alert"
      data-testid="group-scheduling-empty"
      data-reason={reason}
      className="rounded-xl border border-nq-warning/45 bg-nq-warning/10 px-4 py-5 text-sm"
    >
      <p>
        {isCapacityEmpty
          ? (groupCopy.groupNoAlternatives ?? fallbackCopy)
          : fallbackCopy}
      </p>
      <div className="mt-3 flex gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={onBack}
          className="h-9 min-h-9 rounded-full border border-[var(--booking-border)] bg-transparent px-3 text-xs"
        >
          {/* Keep the legacy "Try another date" copy on the
              fallback path — the new "Try a different date"
              wording is reserved for the alternatives panel
              below, where the surrounding cards make the
              slightly different phrasing read as a back-out. */}
          {groupCopy.schedulingTryDate ?? "Try another date"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={onRetry}
          className="h-9 min-h-9 rounded-full border border-[var(--booking-border)] bg-transparent px-3 text-xs"
        >
          Retry
        </Button>
      </div>
    </div>
  );
}

/**
 * Task #05 — smart-alternatives results panel for step 4. Renders
 * up to three cards (split / next-date / earlier-today) plus a
 * "Try another date" back-out always present as the last resort.
 *
 * The header carries the capacity hint ("Only N spots at TIME")
 * which is reconstructed from the split sub-query's main size +
 * main time when available. When split is null we fall back to
 * the generic "options for your group" headline.
 */
function AlternativesPanel({
  alternatives,
  groupCopy,
  date,
  timezone,
  togetherThresholdMin,
  onPickDate,
  onPickEarlier,
  onPickSplit,
  onBack,
  onRetry,
}: {
  alternatives: GroupAlternatives;
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  date: string;
  timezone: string;
  /** Per-salon togetherness threshold (minutes); falls back to the default. */
  togetherThresholdMin: number;
  onPickDate: (ymd: string) => void;
  onPickEarlier: (kind: "morning" | "afternoon" | "evening") => void;
  onPickSplit: (split: NonNullable<GroupAlternatives["splitOption"]>) => void;
  onBack: () => void;
  onRetry: () => void;
}) {
  // Friendly date label: "Tomorrow" when the next-date is +1 day
  // in salon-tz, otherwise localized weekday + day-of-month via
  // formatInSalonTz on a noon-UTC anchor (avoids midnight edge
  // cases where a UTC instant lands in the wrong salon-tz day).
  function labelForDate(ymd: string): string {
    const tomorrow = salonDateOffset(timezone, 1);
    if (ymd === tomorrow) {
      return groupCopy.groupTomorrow ?? "Tomorrow";
    }
    const noonUtc = new Date(Date.parse(`${ymd}T12:00:00Z`)).toISOString();
    return formatInSalonTz(noonUtc, timezone, "date");
  }

  const split = alternatives.splitOption;
  const next = alternatives.nextAvailableDate;
  const earlier = alternatives.earlierToday;

  // Pha 1 — togetherness-aware ordering. Measure how far apart the split's
  // main group and the late member start (both are wall-clock "HH:MM").
  const hmToMin = (hm: string): number => {
    const [h, m] = hm.split(":").map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
  };
  const splitGapMin = split
    ? Math.abs(hmToMin(split.lateTime) - hmToMin(split.mainTime))
    : NaN;
  // When the split keeps everyone within the threshold it still feels
  // "together" → offer it first. When the gap is larger it reads as a real
  // split → lead with an all-together-different-time option instead.
  const threshold =
    Number.isFinite(togetherThresholdMin) && togetherThresholdMin >= 0
      ? togetherThresholdMin
      : GROUP_TOGETHER_THRESHOLD_MIN;
  const splitStaysTogether =
    split !== null &&
    Number.isFinite(splitGapMin) &&
    splitGapMin <= threshold;

  // Header capacity hint — pulled from the split sub-query when
  // present, since that's the only one that knows "N-1 fit at
  // mainTime". When split is null we surface the generic title.
  const showCapacityHint = split !== null;

  const splitCard = split ? (
    <AlternativeCard
      testid="group-alt-split"
      icon="👥"
      title={(groupCopy.groupSplitOption ?? "{n} together at {time}, {late} more by {lateTime}")
        .replace("{n}", String(split.mainSize))
        .replace("{time}", split.mainTime)
        .replace("{late}", String(split.lateCount))
        .replace("{lateTime}", split.lateTime)}
      subtitle={
        splitStaysTogether
          ? (groupCopy.groupSplitStillTogether ??
              "Still together — just {gap} min apart ✨").replace(
              "{gap}",
              String(splitGapMin),
            )
          : (groupCopy.groupSplitDone ?? "Everyone done by {time}").replace(
              "{time}",
              split.assignments[split.assignments.length - 1]?.endDisplay ?? "",
            )
      }
      ctaLabel={groupCopy.groupChooseOption ?? "Choose this option →"}
      onClick={() => onPickSplit(split)}
    />
  ) : null;

  const earlierCard = earlier ? (
    <AlternativeCard
      testid="group-alt-earlier"
      icon="🕙"
      title={(groupCopy.groupEarlierToday ?? "Same day at {time} — {n} people together")
        .replace("{n}", String(earlier.arrangement.assignments.length))
        .replace("{time}", earlier.time)}
      subtitle={null}
      ctaLabel={groupCopy.groupChooseOption ?? "Choose this option →"}
      // The scheduler reports exactly which window this arrangement lands in
      // (morning/afternoon/evening) — flip the selection deterministically.
      onClick={() => onPickEarlier(earlier.arrivalKind)}
    />
  ) : null;

  return (
    <div
      role="region"
      aria-label={groupCopy.groupAlternativesTitle ?? "We found options for your group!"}
      data-testid="group-scheduling-alternatives"
      className="space-y-3"
    >
      <div className="rounded-xl border border-nq-primary/40 bg-nq-primary/5 px-4 py-3">
        <p className="text-sm font-semibold">
          <span aria-hidden>✨ </span>
          {groupCopy.groupAlternativesTitle ?? "We found options for your group!"}
        </p>
        {showCapacityHint && split ? (
          <p className="mt-1 text-xs text-nq-muted">
            {(groupCopy.groupPartialCapacity ?? "Only {n} spots available at {time}.")
              .replace("{n}", String(split.mainSize))
              .replace("{time}", split.mainTime)}
          </p>
        ) : null}
      </div>

      {/* Togetherness-aware order: a small offset still feels "together" so
          we lead with the split; a larger gap reads as a real split, so we
          lead with an all-together-different-time option instead. */}
      {splitStaysTogether ? (
        <>
          {splitCard}
          {earlierCard}
        </>
      ) : (
        <>
          {earlierCard}
          {splitCard}
        </>
      )}

      {next ? (
        <AlternativeCard
          testid={`group-alt-next-${next.date}`}
          // QA BUG-08: the 📅 glyph renders as a literal date ("JUL 17") next to
          // the "Tomorrow" label, looking like a contradiction. Use a neutral
          // "next" glyph instead.
          icon="🔜"
          title={(next.arrangement.isWaveBooking
            ? (groupCopy.groupNextDateWaves ??
              "{label} — {n} people in {waves} waves from {time}")
            : (groupCopy.groupNextDate ??
              "{label} — {n} people together at {time}"))
            .replace("{label}", labelForDate(next.date))
            .replace("{n}", String(next.arrangement.assignments.length))
            .replace("{waves}", String(next.arrangement.waveCount))
            .replace("{time}", next.time)}
          subtitle={null}
          ctaLabel={groupCopy.groupChooseOption ?? "Choose this option →"}
          onClick={() => onPickDate(next.date)}
        />
      ) : null}

      {/* Explicit "keep us together" escape hatch — when a partial/split is on
          offer, let the customer decline the small offset in one tap and jump
          straight to an all-together time (same-day preferred, else next day). */}
      {split && (earlier || next) ? (
        <button
          type="button"
          data-testid="group-alt-prefer-together"
          onClick={() => {
            if (earlier) onPickEarlier(earlier.arrivalKind);
            else if (next) onPickDate(next.date);
          }}
          className="w-full rounded-xl border border-nq-primary/40 bg-nq-primary/5 px-4 py-3 text-sm font-medium text-nq-primary transition-colors hover:bg-nq-primary/10"
        >
          {groupCopy.groupPreferAllTogether ??
            "I'd rather everyone start at the same time →"}
        </button>
      ) : null}

      <div className="flex gap-2 pt-1">
        <Button
          type="button"
          variant="secondary"
          onClick={onBack}
          className="h-9 min-h-9 rounded-full border border-[var(--booking-border)] bg-transparent px-3 text-xs"
        >
          {groupCopy.groupTryDifferentDate ??
            groupCopy.schedulingTryDate ??
            "Try a different date"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={onRetry}
          className="h-9 min-h-9 rounded-full border border-[var(--booking-border)] bg-transparent px-3 text-xs"
        >
          Retry
        </Button>
      </div>

      {/* Reference `date` so the linter doesn't flag the prop as unused —
          it's threaded through for symmetry with `labelForDate`'s
          potential future use of the current day as a comparison anchor. */}
      <span hidden aria-hidden data-cur-date={date} />
    </div>
  );
}

function AlternativeCard({
  testid,
  icon,
  title,
  subtitle,
  ctaLabel,
  onClick,
}: {
  testid: string;
  icon: string;
  title: string;
  subtitle: string | null;
  ctaLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      className="flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--booking-border)] bg-nq-surface px-4 py-3 text-left transition-colors hover:border-nq-primary/55 focus:border-nq-primary focus:outline-none focus:ring-2 focus:ring-nq-primary/35"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span aria-hidden className="text-xl leading-none">
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-nq-foreground">
            {title}
          </p>
          {subtitle ? (
            <p className="mt-0.5 text-xs text-nq-muted">{subtitle}</p>
          ) : null}
        </div>
      </div>
      <span
        aria-hidden
        className="shrink-0 text-xs font-semibold text-nq-primary"
      >
        {ctaLabel}
      </span>
    </button>
  );
}

// ─── STEP 5 — Confirm ────────────────────────────────────────────

function ConfirmStep({
  t,
  groupCopy,
  arrangement,
  members,
  services,
  date,
  timezone,
  showStaff,
  primaryPhone,
  primaryEmail,
  organizer,
  organizerLoading,
  organizerIsGuest,
  onOrganizerIsGuestChange,
  submitting,
  errorMessage,
  totalDisplay,
  pricingQuote,
  pricingLoading,
  pricingError,
  maxMinutes,
  size,
  contactReady,
  showStaleArrangement,
  onStaleAcknowledge,
  onStaleRefresh,
  showSessionWarning,
  showSlotJustTaken,
  onPhoneChange,
  onEmailChange,
  onBack,
  onSubmit,
  initialSmsConsent,
  onSmsConsentChange,
  salonName,
  cardRequirement,
  cardRequirementLoading,
  cardRef,
  noShowConsent,
  onNoShowConsentChange,
  currencyCode,
  baseTotalCents,
  appliedVoucher,
  onApplyVoucher,
  onRemoveVoucher,
}: {
  t: BookingMessages;
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  arrangement: GroupArrangement | null;
  members: readonly MemberDraft[];
  services: readonly BookingServiceItem[];
  date: string;
  timezone: string;
  showStaff: boolean;
  primaryPhone: string;
  primaryEmail: string;
  /** Returning-customer match for the organizer phone, or null. */
  organizer: ReturningCustomer | null;
  organizerLoading: boolean;
  /** Whether the organizer is also one of the guests. */
  organizerIsGuest: boolean;
  onOrganizerIsGuestChange: (v: boolean) => void;
  submitting: boolean;
  errorMessage: string | null;
  totalDisplay: string | null;
  pricingQuote: GroupBookingPricingQuote | null;
  pricingLoading: boolean;
  pricingError: string | null;
  maxMinutes: number;
  size: number;
  /** Computed by parent — phone ≥ 10 digits AND email empty-or-valid. */
  contactReady: boolean;
  /** FIX 03 — true when arrangement age > 3 min and user hasn't
   *  acknowledged yet. Renders the staleness warning + actions. */
  showStaleArrangement: boolean;
  onStaleAcknowledge: () => void;
  onStaleRefresh: () => void;
  /** FIX 14 — true when user has been on step 5 for ≥ 25 min. */
  showSessionWarning: boolean;
  /** Task #04-C FIX 01 — true while the pre-submit availability
   *  probe is auto-rescheduling after detecting a raced slot. */
  showSlotJustTaken: boolean;
  onPhoneChange: (v: string) => void;
  onEmailChange: (v: string) => void;
  onBack: () => void;
  onSubmit: () => void;
  /** SMS consent already given at the phone gate → pre-satisfies confirm. */
  initialSmsConsent: boolean;
  /** Lifts the ticked state so the submit payload reports real consent. */
  onSmsConsentChange: (v: boolean) => void;
  /** Interpolated into the consent disclosure — Twilio requires the brand name. */
  salonName: string;
  /** No-show card requirement for the organizer (Option A — captured here,
   *  before the group is created). Null while loading / not required. */
  cardRequirement: NoShowCardRequirement | null;
  /** True while resolveNoShowCardRequirement is in-flight. */
  cardRequirementLoading: boolean;
  /** Imperative handle to tokenize the entered card at submit time. */
  cardRef: React.RefObject<ConfirmStepCardHandle | null>;
  /** No-show policy consent (separate from SMS consent). */
  noShowConsent: boolean;
  onNoShowConsentChange: (v: boolean) => void;
  /** Salon currency — for the no-show card fee label. */
  currencyCode: BookingSalonMeta["currencyCode"];
  /** Whole-party base total (pre-voucher), for voucher validation. */
  baseTotalCents: number | null;
  /** Applied whole-party voucher, or null. */
  appliedVoucher: {
    voucher_id: string;
    code: string;
    discount_cents: number;
    final_price_cents: number;
  } | null;
  onApplyVoucher: (code: string, totalCents: number) => Promise<{ error?: string }>;
  onRemoveVoucher: () => void;
}) {
  const dateDisplay = useMemo(() => {
    // Display the chosen date in salon-tz long form. The
    // arrangement carries UTC ISO; reuse formatInSalonTz for
    // consistency with the per-row times.
    const firstStart = arrangement?.assignments[0]?.startUtcIso;
    if (!firstStart) return date;
    return formatInSalonTz(firstStart, timezone, "date");
  }, [arrangement, date, timezone]);

  // QA BUG-03 — express SMS consent, required before confirming the party.
  // Pre-satisfied from the phone gate (initialSmsConsent) so the customer
  // doesn't tick the same consent twice (gate + group confirm).
  const [smsConsent, setSmsConsent] = useState(initialSmsConsent);

  // Whole-party voucher input (mirrors the individual confirm panel).
  const [voucherInput, setVoucherInput] = useState("");
  const [voucherError, setVoucherError] = useState<string | null>(null);
  const [voucherLoading, setVoucherLoading] = useState(false);
  async function handleApplyVoucherLocal() {
    const code = voucherInput.trim().toUpperCase();
    if (!code || baseTotalCents == null || baseTotalCents <= 0) return;
    setVoucherError(null);
    setVoucherLoading(true);
    const result = await onApplyVoucher(code, baseTotalCents);
    setVoucherLoading(false);
    if (result.error) {
      const errors = t.voucherErrors as Record<string, string>;
      setVoucherError(errors[result.error] ?? errors.generic ?? result.error);
    } else {
      setVoucherInput("");
    }
  }

  if (!arrangement) {
    return (
      <p
        role="alert"
        className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error"
      >
        {groupCopy.schedulingNoSlots ?? "Please pick an arrangement first."}
      </p>
    );
  }

  // P1 #18 / #19 (QA re-sweep 2026-05-12) — live-derived field
  // validity. Mirrors the BookingFlowInfoPanel pattern: only flag
  // invalid once the user has typed something (empty = no error
  // before they've engaged). Drives `aria-invalid`, the red field
  // border, and the inline `role="alert"` text below each input —
  // a non-sighted user no longer has to wait for the submit banner
  // to learn which field is wrong.
  const phoneTrim = primaryPhone.trim();
  const phoneLocallyInvalid =
    phoneTrim.length > 0 && !validateGuestPhone(phoneTrim).ok;
  const emailTrim = primaryEmail.trim();
  const emailLocallyInvalid =
    emailTrim.length > 0 && !isValidEmailFormat(emailTrim);

  return (
    <div className="space-y-4 pb-32" data-testid="group-step-confirm-panel">
      <h2 className="text-lg font-semibold sm:text-xl">
        {t.stepConfirmHeading}
      </h2>

      {/* Task #04-C FIX 01 — slot-just-taken banner. Shown while
          the pre-submit probe is auto-rescheduling. Disappears
          when the new arrangements land (probe effect resets the
          flag). Non-blocking; Confirm button is still functional
          but the user will see the new arrangement once the
          scheduler returns. */}
      {showSlotJustTaken ? (
        <p
          role="status"
          aria-live="polite"
          data-testid="group-slot-just-taken"
          className="rounded-xl border border-nq-warning/45 bg-nq-warning/10 px-3 py-2 text-xs"
        >
          {groupCopy.slotTakenRefinding ??
            "A slot was just taken. Finding new options..."}
        </p>
      ) : null}

      {/* FIX 03 — stale arrangement banner. The user can either
          acknowledge ("Confirm anyway" dismisses just the banner)
          or refresh (re-runs the scheduler, lands back on step 4
          with fresh options). Server still runs a final conflict
          check as a backstop. */}
      {showStaleArrangement ? (
        <div
          role="alert"
          data-testid="group-arrangement-stale"
          className="rounded-xl border border-nq-warning/45 bg-nq-warning/10 px-4 py-3 text-sm"
        >
          <p>
            {groupCopy.arrangementStale ?? "This arrangement is 3+ min old."}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={onStaleAcknowledge}
              data-testid="group-stale-ack"
              className="h-9 min-h-9 rounded-full border border-[var(--booking-border)] bg-transparent px-3 text-xs"
            >
              {groupCopy.confirmAnyway ?? "Confirm anyway"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={onStaleRefresh}
              data-testid="group-stale-refresh"
              className="h-9 min-h-9 rounded-full border border-[var(--booking-border)] bg-transparent px-3 text-xs"
            >
              {groupCopy.refreshSchedule ?? "Refresh schedule"}
            </Button>
          </div>
        </div>
      ) : null}

      {/* FIX 14 — session-idle reminder. Non-blocking; renders
          alongside the form rather than overlaying it. */}
      {showSessionWarning ? (
        <p
          role="status"
          data-testid="group-session-warning"
          className="rounded-xl border border-nq-warning/45 bg-nq-warning/10 px-3 py-2 text-xs"
        >
          {groupCopy.sessionExpiringSoon ??
            "Session expiring soon. Please confirm."}
        </p>
      ) : null}

      <div className="rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-4 sm:p-5">
        <p className="text-xs text-[var(--booking-text-muted)]">
          {dateDisplay}
        </p>
        <ul className="mt-3 space-y-2 text-sm">
          {arrangement.assignments.map((a) => {
            const draft = members[a.memberIndex];
            const svc = services.find((s) => s.id === draft?.serviceId);
            const addonCount = draft?.addonServiceIds.length ?? 0;
            const memberReceipt = pricingQuote?.memberQuotes[a.memberIndex];
            return (
              <li
                key={a.memberIndex}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-[var(--booking-border)]/60 pb-2 last:border-b-0 last:pb-0"
              >
                <span className="font-medium">{draft?.name || "—"}</span>
                <span className="text-[var(--booking-text-muted)]">
                  {a.startDisplay}
                  {showStaff ? ` · ${a.staffName}` : ""} ·{" "}
                  {svc?.name ?? a.serviceName}
                  {addonCount > 0 ? ` · +${addonCount} add-on` : ""}
                  {memberReceipt
                    ? ` · ${formatCurrency(memberReceipt.totalCents, pricingQuote.currency) ?? ""}`
                    : ""}
                </span>
              </li>
            );
          })}
        </ul>
        {pricingLoading ? (
          <p className="mt-3 text-xs text-[var(--booking-text-muted)]" role="status">
            Refreshing the party total…
          </p>
        ) : pricingError || !pricingQuote ? (
          <p className="mt-3 text-xs text-nq-error" role="alert" data-testid="group-pricing-unavailable">
            We couldn&apos;t verify the party total. Please try again.
          </p>
        ) : (
          <div className="mt-4 space-y-1 border-t border-[var(--booking-border)] pt-3 text-sm" data-testid="group-authoritative-receipt">
            {pricingQuote.discountLines.map((line) => (
              <div key={`${line.kind}:${line.label}`} className="flex justify-between gap-3 text-[var(--booking-text-muted)]">
                <span>{line.label}</span>
                <span>−{formatCurrency(line.amountCents, pricingQuote.currency)}</span>
              </div>
            ))}
            {pricingQuote.taxBreakdown.map((line) => (
              <div key={`${line.name}:${line.rate}`} className="flex justify-between gap-3 text-[var(--booking-text-muted)]">
                <span>{line.name}</span>
                <span>{formatCurrency(line.amountCents, pricingQuote.currency)}</span>
              </div>
            ))}
            <div className="flex justify-between gap-3 font-semibold" data-testid="group-authoritative-total">
              <span>{groupCopy.groupTotal ?? groupCopy.totalLabel ?? "Total"}</span>
              <span>{formatCurrency(pricingQuote.totalCents, pricingQuote.currency)}</span>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h3 className="text-base font-semibold">
          {groupCopy.primaryContactHeading}
        </h3>
        <p className="text-xs text-[var(--booking-text-muted)]">
          {groupCopy.primaryContactHint}
        </p>

        {/* Organizer recognition — greet returning guests by name. */}
        {organizer ? (
          <div
            data-testid="group-organizer-recognized"
            className="flex items-start gap-2 rounded-xl border border-[var(--salon-primary)]/40 bg-[var(--salon-primary)]/5 px-3 py-2.5"
          >
            <span aria-hidden className="text-lg leading-none">
              👋
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold">
                {/* Name/visits/usual are NOT revealed pre-OTP (privacy fix S1) —
                    fall back to a generic greeting. The name path stays for a
                    future post-verification fetch. */}
                {organizer.name?.trim()
                  ? (groupCopy.organizerGreeting ?? "Welcome back, {name}!").replace(
                      "{name}",
                      organizer.name,
                    )
                  : t.returningCustomer.welcomeBack}
                {organizer.isVip ? (
                  <span className="ml-1.5 rounded-full bg-[var(--salon-primary)]/15 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-[var(--salon-primary)]">
                    {groupCopy.organizerVip ?? "VIP"}
                  </span>
                ) : null}
              </span>
              {(organizer.visitCount ?? 0) > 0 || organizer.lastBooking ? (
                <span className="mt-0.5 block text-xs text-[var(--booking-text-muted)]">
                  {(organizer.visitCount ?? 0) > 0
                    ? (groupCopy.organizerReturning ?? "Returning guest · {n} visits").replace(
                        "{n}",
                        String(organizer.visitCount ?? 0),
                      )
                    : null}
                  {organizer.lastBooking
                    ? `${(organizer.visitCount ?? 0) > 0 ? " · " : ""}${(
                        groupCopy.organizerUsual ?? "Usual: {service}"
                      ).replace("{service}", organizer.lastBooking.serviceName)}`
                    : null}
                </span>
              ) : null}
            </span>
          </div>
        ) : organizerLoading ? (
          <p
            data-testid="group-organizer-loading"
            className="text-xs text-[var(--booking-text-muted)]"
          >
            {groupCopy.organizerChecking ?? "Checking…"}
          </p>
        ) : null}

        {/* Is the contact also one of the guests? Drives whether their
            own slot is pre-claimed in the Party Link (so they're never
            asked to "claim" themselves). */}
        <label
          data-testid="group-organizer-is-guest"
          className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] px-3 py-2.5"
        >
          <input
            type="checkbox"
            checked={organizerIsGuest}
            onChange={(e) => onOrganizerIsGuestChange(e.target.checked)}
            className="h-4 w-4 shrink-0 accent-[var(--salon-primary)]"
          />
          <span className="text-sm font-medium">
            {groupCopy.organizerIsGuestLabel ??
              "I'm also getting a service with the group"}
          </span>
        </label>

        <div>
          <label
            htmlFor="group-primary-phone-input"
            className="mb-1 block text-sm font-medium text-[var(--booking-text)]"
          >
            {t.clientPhoneLabel}
          </label>
          <input
            id="group-primary-phone-input"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            data-testid="group-primary-phone"
            value={primaryPhone}
            maxLength={24}
            placeholder={t.clientPhonePlaceholder}
            onChange={(e) => onPhoneChange(e.target.value)}
            aria-invalid={phoneLocallyInvalid || undefined}
            aria-describedby={
              phoneLocallyInvalid ? "group-primary-phone-error" : undefined
            }
            className={cn(
              "nq-booking-field",
              phoneLocallyInvalid && "border-nq-error/50",
            )}
          />
          {phoneLocallyInvalid ? (
            <p
              id="group-primary-phone-error"
              role="alert"
              data-testid="group-primary-phone-error"
              className="mt-1 text-xs text-nq-error"
            >
              {groupCopy.contactInvalidPhone ??
                "The phone number isn't valid."}
            </p>
          ) : null}
        </div>
        <div>
          <label
            htmlFor="group-primary-email-input"
            className="mb-1 block text-sm font-medium text-[var(--booking-text)]"
          >
            {t.clientEmailLabel}
          </label>
          <input
            id="group-primary-email-input"
            type="email"
            autoComplete="email"
            data-testid="group-primary-email"
            value={primaryEmail}
            placeholder={t.clientEmailLabel}
            onChange={(e) => onEmailChange(e.target.value)}
            aria-invalid={emailLocallyInvalid || undefined}
            aria-describedby={
              emailLocallyInvalid ? "group-primary-email-error" : undefined
            }
            className={cn(
              "nq-booking-field",
              emailLocallyInvalid && "border-nq-error/50",
            )}
          />
          {emailLocallyInvalid ? (
            <p
              id="group-primary-email-error"
              role="alert"
              data-testid="group-primary-email-error"
              className="mt-1 text-xs text-nq-error"
            >
              {groupCopy.contactInvalidEmail ??
                "The email format isn't valid."}
            </p>
          ) : null}
        </div>
      </div>

      {errorMessage ? (
        <p
          role="alert"
          data-testid="group-error"
          className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error"
        >
          {errorMessage}
        </p>
      ) : null}

      {/* Option A — no-show card for the organizer, captured BEFORE the group
          is created (mirrors the individual confirm panel). The card is
          tokenized at submit and saved to the lead booking on success, so a
          confirmed party is already protected — never an afterthought on the
          success screen. */}
      {cardRequirement?.required ? (
        <div className="mb-4 rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-4">
          <p className="text-sm font-semibold text-[var(--booking-text)]">
            {t.noShowCardTitle ?? "Secure your appointment"}
          </p>
          <ConfirmStepCardCapture
            ref={cardRef}
            applicationId={cardRequirement.applicationId}
            locationId={cardRequirement.locationId}
            environment={cardRequirement.environment}
            feeLabel={formatCurrency(cardRequirement.feeCents, currencyCode) ?? ""}
            customerName={organizer?.name ?? members[0]?.name ?? ""}
            customerPhone={primaryPhone}
            customerEmail={primaryEmail}
            t={t}
          />
          <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-xs leading-relaxed text-[var(--booking-text-muted)]">
            <input
              type="checkbox"
              data-testid="group-noshow-consent"
              checked={noShowConsent}
              onChange={(e) => onNoShowConsentChange(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--salon-primary)]"
            />
            <span>
              {(t.noShowConsent ??
                "I agree to the no-show policy and authorize this salon to charge {fee} to this card only if I don't show up.").replace(
                "{fee}",
                formatCurrency(cardRequirement.feeCents, currencyCode) ?? "",
              )}
            </span>
          </label>
        </div>
      ) : null}

      {/* Whole-party voucher / discount code (mirrors the individual confirm
          panel). Auto-filled when the party arrives via a /?code= link. */}
      {baseTotalCents != null && baseTotalCents > 0 ? (
        <div className="mb-3">
          {appliedVoucher ? (
            <div className="flex items-center justify-between rounded-xl border border-[var(--salon-primary)]/40 bg-[color-mix(in_srgb,var(--salon-primary)_10%,transparent)] px-4 py-3">
              <p className="text-sm font-medium text-[var(--booking-text)]">
                {(t.voucherApplied as string).replace("{code}", appliedVoucher.code)}
                {appliedVoucher.discount_cents > 0
                  ? ` · –${formatCurrency(appliedVoucher.discount_cents, currencyCode) ?? ""}`
                  : ""}
              </p>
              <button
                type="button"
                onClick={() => { onRemoveVoucher(); setVoucherError(null); }}
                className="ml-3 shrink-0 text-xs text-[var(--booking-text-muted)] underline underline-offset-2"
              >
                {t.voucherRemove}
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                type="text"
                value={voucherInput}
                onChange={(e) => { setVoucherInput(e.target.value.toUpperCase()); setVoucherError(null); }}
                onKeyDown={(e) => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === "Enter") { e.preventDefault(); void handleApplyVoucherLocal(); } }}
                placeholder={t.voucherPlaceholder}
                maxLength={32}
                className="nq-booking-glass h-12 min-w-0 flex-1 rounded-xl border border-[var(--booking-border)] bg-[var(--booking-bg-input)] px-3 text-sm text-[var(--booking-text)] placeholder:text-[var(--booking-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--salon-primary)]/40"
                aria-label={t.voucherLabel}
              />
              <button
                type="button"
                disabled={!voucherInput.trim() || voucherLoading}
                onClick={() => void handleApplyVoucherLocal()}
                className="h-12 shrink-0 rounded-xl border border-[var(--booking-border)] bg-[var(--booking-bg-input)] px-4 text-sm font-medium text-[var(--booking-text)] transition-colors hover:bg-[var(--booking-bg-input)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {voucherLoading ? "…" : t.voucherApply}
              </button>
            </div>
          )}
          {voucherError && (
            <p className="mt-1.5 text-xs text-nq-error" role="alert">{voucherError}</p>
          )}
        </div>
      ) : null}

      {/* SMS consent is captured at the phone gate; only show it here as a
          fallback when it wasn't already given (mirrors the individual confirm
          panel) — never ask the customer to tick the same consent twice. */}
      {!smsConsent ? (
        <label className="mb-3 flex cursor-pointer items-start gap-2.5 text-xs leading-relaxed text-[var(--booking-text-muted)]">
          <input
            type="checkbox"
            data-testid="group-sms-consent"
            checked={smsConsent}
            onChange={(e) => {
              setSmsConsent(e.target.checked);
              onSmsConsentChange(e.target.checked);
            }}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--salon-primary)]"
          />
          <span>{t.smsConsent.replace("{salon}", salonName)}</span>
        </label>
      ) : null}

      <StickyFooter
        leftLabel={groupCopy.groupTotal ?? groupCopy.totalLabel ?? "Total"}
        leftValue={
          <span>
            {size} {groupCopy.peopleSuffix ?? "people"}
            {totalDisplay ? ` · ${totalDisplay}` : ""}
            {/* QA BUG-07: maxMinutes is the per-PERSON service length, so showing
               it as the group's "65 min" misled multi-wave parties. Show the real
               group span (first start → last end) instead. */}
            {arrangement
              ? ` · ${formatInSalonTz(new Date(arrangement.groupStartMs).toISOString(), timezone, "time")}–${formatInSalonTz(new Date(arrangement.groupEndMs).toISOString(), timezone, "time")}`
              : maxMinutes > 0
                ? ` · ${maxMinutes} ${t.minuteSuffixShort}`
                : ""}
          </span>
        }
      >
        <Button
          type="button"
          variant="secondary"
          onClick={onBack}
          data-testid="group-back"
          className="nq-booking-glass h-11 min-h-11 shrink-0 border border-[var(--booking-border)] bg-transparent text-[var(--booking-text-muted)] shadow-none"
        >
          {t.back}
        </Button>
        <LuxuryBookingCta
          onClick={onSubmit}
          disabled={
            submitting ||
            cardRequirementLoading ||
            pricingLoading ||
            !pricingQuote ||
            Boolean(pricingError) ||
            !contactReady ||
            !smsConsent ||
            (cardRequirement?.required === true && !noShowConsent)
          }
          data-testid="group-confirm"
        >
          {submitting ? groupCopy.submittingGroup : groupCopy.confirmGroup}
        </LuxuryBookingCta>
      </StickyFooter>
    </div>
  );
}

// ─── Success ─────────────────────────────────────────────────────

function SuccessPanel({
  groupCopy,
  t,
  successResult,
  members,
  services,
  scheduleResult,
  selectedArrangementIdx,
  date,
  showStaff,
  seatTogether,
  partyLinkUrl,
  partyLinkFailed,
  currencyCode,
  otpSessionId,
  salonId,
}: {
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  t: BookingMessages;
  successResult: {
    groupId: string;
    bookingIds: string[];
    pricing: GroupBookingPricingQuote;
    cardManagementToken: string | null;
  };
  showStaff: boolean;
  /** Couple/group asked to be seated together — warm confirmation line. */
  seatTogether: boolean;
  members: readonly MemberDraft[];
  services: readonly BookingServiceItem[];
  scheduleResult: GroupSmartScheduleResult | null;
  selectedArrangementIdx: number;
  /** FIX 18 — booking date powers the YYYYMMDD prefix in the
   *  group reference. Passed in rather than re-derived from the
   *  arrangement assignments so success works even if scheduleResult
   *  was already cleared. */
  date: string;
  /** Phase 2 — shareable party link URL, set asynchronously.
   *  null while the createPartyLink call is in flight or if it failed. */
  partyLinkUrl: string | null;
  /** True when createPartyLink returned ok:false or threw — triggers non-blocking warning. */
  partyLinkFailed: boolean;
  /** Salon currency — for the no-show card-capture fee label. */
  currencyCode: BookingSalonMeta["currencyCode"];
  /** OTP session id (organizer) — gates one-tap reuse of a saved card. */
  otpSessionId: string | null;
  /** Salon id — needed to resolve the organizer's saved card on file. */
  salonId: string;
}) {
  const arrangement =
    scheduleResult && scheduleResult.ok
      ? scheduleResult.arrangements[selectedArrangementIdx]
      : null;

  // Resolve the organizer's saved card on file (if any) so the no-show capture
  // can offer one-tap reuse instead of fresh entry — mirroring the single flow.
  const leadBookingId = successResult.bookingIds[0];
  const [savedCard, setSavedCard] = useState<SavedNoShowCard | null>(null);
  useEffect(() => {
    if (!leadBookingId || !otpSessionId) return;
    let alive = true;
    resolveSavedNoShowCard({ salonId, otpSessionId })
      .then((r) => {
        if (alive) setSavedCard(r);
      })
      .catch(() => {
        if (alive) setSavedCard(null); // best-effort: fall back to fresh entry
      });
    return () => {
      alive = false;
    };
  }, [leadBookingId, otpSessionId, salonId]);

  return (
    <section
      data-testid="booking-group-success"
      className="mt-8 rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-6 text-center"
      style={{ color: "var(--booking-text)" }}
    >
      <h2 className="text-xl font-semibold sm:text-2xl">
        {groupCopy.groupSuccess ?? groupCopy.successHeading}
      </h2>
      <p
        className="mt-2 text-sm text-[var(--booking-text-muted)]"
        data-testid="group-success-reference"
      >
        {(groupCopy.groupRef ?? "Reference") + " "}
        {formatGroupRef(successResult.groupId, date)}
      </p>
      {arrangement ? (
        <ul className="mt-5 space-y-2 text-left text-sm">
          {arrangement.assignments.map((a) => {
            const draft = members[a.memberIndex];
            const svc = services.find((s) => s.id === draft?.serviceId);
            return (
              <li
                key={a.memberIndex}
                className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--booking-border)] pb-2"
              >
                <span className="font-semibold">{draft?.name}</span>
                <span className="text-[var(--booking-text-muted)]">
                  {a.startDisplay} · {svc?.name ?? a.serviceName}
                  {showStaff ? ` · ${a.staffName}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div
        className="mt-5 rounded-xl border border-[var(--booking-border)] p-4 text-left text-sm"
        data-testid="group-success-authoritative-receipt"
      >
        {successResult.pricing.memberQuotes.map((member) => {
          const draft = members[member.memberIndex];
          const service = services.find((item) => item.id === member.serviceId);
          return (
            <div key={member.memberIndex} className="flex justify-between gap-3 py-1 text-[var(--booking-text-muted)]">
              <span>{draft?.name ?? `Guest ${member.memberIndex + 1}`} · {service?.name ?? "Service"}</span>
              <span>{formatCurrency(member.totalCents, successResult.pricing.currency)}</span>
            </div>
          );
        })}
        {successResult.pricing.discountLines.map((line) => (
          <div key={`${line.kind}:${line.label}`} className="flex justify-between gap-3 py-1 text-[var(--booking-text-muted)]">
            <span>{line.label}</span>
            <span>−{formatCurrency(line.amountCents, successResult.pricing.currency)}</span>
          </div>
        ))}
        {successResult.pricing.taxBreakdown.map((line) => (
          <div key={`${line.name}:${line.rate}`} className="flex justify-between gap-3 py-1 text-[var(--booking-text-muted)]">
            <span>{line.name}</span>
            <span>{formatCurrency(line.amountCents, successResult.pricing.currency)}</span>
          </div>
        ))}
        <div className="mt-2 flex justify-between gap-3 border-t border-[var(--booking-border)] pt-2 font-semibold" data-testid="group-success-authoritative-total">
          <span>{groupCopy.groupTotal ?? groupCopy.totalLabel ?? "Total"}</span>
          <span>{formatCurrency(successResult.pricing.totalCents, successResult.pricing.currency)}</span>
        </div>
      </div>

      {seatTogether ? (
        <p
          data-testid="group-success-seat-together"
          className="mt-4 rounded-xl border border-[var(--salon-primary)]/40 bg-[var(--salon-primary)]/5 px-3 py-2 text-sm font-medium"
        >
          {groupCopy.seatTogetherConfirm ??
            "We'll seat your group next to each other 💕"}
        </p>
      ) : null}

      {/* Party Link share section — shown once the async call resolves */}
      {partyLinkUrl ? (
        <PartyLinkShareBox url={partyLinkUrl} groupCopy={groupCopy} />
      ) : partyLinkFailed ? (
        <p
          data-testid="party-link-warning"
          className="mt-4 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-400"
        >
          {groupCopy.partyLinkUnavailable}
        </p>
      ) : null}

      {/* No-show card capture for the organizer (lead booking carries the
          phone). Self-gates: renders the card form only when the lead is
          risk-flagged + Square is configured — same as the individual flow. */}
      {successResult.bookingIds[0] && successResult.cardManagementToken ? (
        <div className="mt-5 text-left">
          <NoShowCardCapture
            bookingId={successResult.bookingIds[0]}
            managementToken={successResult.cardManagementToken}
            currencyFormat={(cents) => formatCurrency(cents, currencyCode) ?? ""}
            t={t}
            savedCard={savedCard}
            otpSessionId={otpSessionId}
          />
        </div>
      ) : null}
    </section>
  );
}

// ─── PartyLinkShareBox ────────────────────────────────────────────

function PartyLinkShareBox({
  url,
  groupCopy,
}: {
  url: string;
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
}) {
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);

  // navigator.share is mobile-only + must be feature-detected after
  // mount (SSR has no navigator). Drives whether the native Share
  // button renders alongside Copy.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot feature detection on mount (no SSR navigator)
    setCanShare(
      typeof navigator !== "undefined" && typeof navigator.share === "function",
    );
  }, []);

  function handleCopy() {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleShare() {
    void navigator
      .share({
        title: groupCopy.partyLinkShare ?? "Join my group booking",
        text: groupCopy.partyLinkScan ?? "Tap to confirm your spot",
        url,
      })
      .catch(() => {
        /* user dismissed the share sheet — no-op */
      });
  }

  return (
    <div
      data-testid="party-link-share"
      className="mt-6 rounded-2xl border border-[var(--salon-primary)]/40 bg-[var(--salon-primary)]/5 p-4 text-center"
    >
      <p className="text-sm font-semibold" style={{ color: "var(--booking-text)" }}>
        {groupCopy.partyLinkShare ?? "Share with your group"}
      </p>
      <p className="mx-auto mt-0.5 max-w-xs text-xs text-[var(--booking-text-muted)]">
        {groupCopy.partyLinkScan ??
          "Each guest scans to confirm their own slot and add their number."}
      </p>

      {/* Scan-to-join QR — the headline action. Couples/friends are
          usually together, so scanning beats copy-pasting a link. */}
      <div className="mt-3 flex justify-center">
        <div
          data-testid="party-link-qr"
          className="rounded-xl bg-white p-3 shadow-sm"
        >
          <QRCodeSVG
            value={url}
            size={148}
            bgColor="#ffffff"
            fgColor="#0b0c10"
            level="M"
          />
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          data-testid="party-link-url"
          readOnly
          value={url}
          aria-label="Party link URL"
          className="flex-1 rounded-lg border border-[var(--booking-border)] bg-[var(--booking-bg-card)] px-3 py-2 text-xs text-[var(--booking-text-muted)] focus:outline-none"
          onFocus={(e) => e.currentTarget.select()}
        />
        {canShare ? (
          <button
            data-testid="party-link-share-btn"
            onClick={handleShare}
            className="shrink-0 rounded-lg bg-[var(--salon-primary)] px-3 py-2 text-xs font-semibold text-[var(--booking-bg)] transition-colors"
          >
            {groupCopy.partyLinkShareBtn ?? "Share"}
          </button>
        ) : null}
        <button
          data-testid="party-link-copy-btn"
          onClick={handleCopy}
          className="shrink-0 rounded-lg bg-gray-900 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-gray-700"
        >
          {copied ? (groupCopy.partyLinkCopied ?? "Copied!") : (groupCopy.partyLinkCopy ?? "Copy")}
        </button>
      </div>
    </div>
  );
}

// ─── Sticky footer (shared) ──────────────────────────────────────

function StickyFooter({
  leftLabel,
  leftValue,
  children,
}: {
  leftLabel: string | null;
  leftValue: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--booking-border)] bg-[var(--booking-bg)] px-4 py-3 backdrop-blur"
      data-testid="group-sticky-footer"
    >
      <div className="mx-auto flex w-full max-w-[680px] flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {leftLabel != null || leftValue != null ? (
          <div className="text-sm" data-testid="group-total-preview">
            {leftLabel != null ? (
              <span className="text-[var(--booking-text-muted)]">
                {leftLabel}:{" "}
              </span>
            ) : null}
            <span className="font-semibold">{leftValue}</span>
          </div>
        ) : (
          <span aria-hidden />
        )}
        <div className="flex gap-2">{children}</div>
      </div>
    </div>
  );
}
