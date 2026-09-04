"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/Button";
import { BOOKING_GUEST_NAME_MAX } from "@/shared/booking/bookingGuestContactLimits";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { WALKIN_GROUP_BUFFER_MS } from "@/shared/config/constants";
import { cn } from "@/shared/lib/cn";
import {
  formatCurrency,
  formatServicePrice as formatServicePriceLabel,
  type Currency,
} from "@/shared/lib/currencyFormat";
import { formatPhoneInputProgressive } from "@/shared/lib/phoneFormat";
import { isValidCustomerName } from "@/shared/lib/nameFormat";
import {
  QUEUE_PRIORITIES,
  QUEUE_REQUEST_TAG_MAX_LEN,
  QUEUE_REQUEST_TAGS_MAX_COUNT,
  QUEUE_SOURCES,
  type QueuePriority,
  type QueueRequestTag,
  type QueueSource,
} from "@/shared/types";
import type {
  ClientLookupProfile,
  ClientLookupResult,
} from "@/shared/dashboard/lookupClientByPhoneAction";
import type {
  AvailabilityResult,
  StaffAvailability,
} from "@/shared/dashboard/availabilityEngine";
import { selectWalkinGapSafeRecommendation } from "@/shared/dashboard/walkinGapSafety";
import { maskPhonePartial } from "@/shared/lib/maskPhone";
import {
  resolveWalkinActualTime,
  walkinActualTimeHm,
} from "@/shared/dashboard/walkinActualTime";

export interface WalkinAddFormProps {
  services: Array<{
    id: string;
    name: string;
    duration_minutes: number;
    buffer_minutes?: number | null;
    price_cents: number;
    price_type: string;
    price_max_cents: number | null;
  }>;
  /** P0.2 — salon's configured currency. Drives the per-service
   * price labels on the tile grid and the VIP profile summary. */
  currency: Currency;
  /** Current observed instant and salon timezone for the compact actual-time
   * correction. The server independently enforces the 30-minute boundary. */
  nowIso: string;
  timezone: string;
  /** Salon setup incomplete — block walk-in intake until catalog is ready */
  disabled?: boolean;
  /**
   * Realtime offline guard. When true, the submit button is locked
   * and an inline offline-specific hint is rendered above it. Mutation
   * guard for the `ConnectionBanner` state — prevents writes against
   * stale data when the realtime channel is erroring/closed.
   */
  isOffline?: boolean;
  /** Localized hint shown when `isOffline` is true. */
  offlineDisabledHint?: string;
  /** Localized strings */
  labels: {
    namePlaceholder: string;
    phonePlaceholder: string;
    notePlaceholder: string;
    addButton: string;
    incompleteHint: string;
    moreServices: string;
    submitting: string;
    errorRequired: string;
    invalidPhone: string;
    phoneRequired: string;
    nameRequired: string;
    nameTooLong: string;
    invalidNameChars: string;
    actualTimeLabel: string;
    actualTimeHint: string;
    actualTimeInvalid: string;
    sourceLabel: string;
    sourceOptions: Record<QueueSource, string>;
    priorityLabel: string;
    priorityOptions: Record<QueuePriority, string>;
    requestTagsLabel: string;
    requestTagsPlaceholder: string;
    requestTagAdd: string;
    requestTagRemove: (label: string) => string;
    moreDetails: string;
    hideDetails: string;
    /** "Khách yêu cầu thợ này" checkbox label. */
    staffRequestedByClient: string;
    /** Phone-lookup card copy. */
    returningCustomer: string;
    newCustomer: string;
    /** "VIP · {visits} visits · ${total}" template — interpolates
     * `{visits}` and `{total}` via simple string replace. */
    profileSummary: string;
    /** "Last visit: {when}" — `{when}` is a localized relative phrase. */
    lastVisitLine: string;
    /** "Usual: {service}" line on the client card. */
    usualServiceLine: string;
    /** "Often with: {staff}" line on the client card. */
    favoriteStaffLine: string;
    /** Loading hint shown next to phone field while debounce fires. */
    lookupLoading: string;
    /** Aria label for the spinner. */
    lookupLoadingAria: string;
    /** Header text when "found" card is rendered. */
    returningCustomerHeader: string;
    /** VIP pill label. */
    vipBadge: string;
    /** Heart-prefix for top staff line, e.g. "❤️ Often with {name}" */
    favoriteStaffPrefix: string;
    /** Notes label prefix shown above the notes paragraph. */
    notesLabel: string;
    /** Smart-availability dropdown + card copy. */
    requestedStaffLabel: string;
    bestMatchOption: string;
    /** "Best Match: {name} — Ready in {wait}" recommendation line. */
    bestMatchRecommendation: string;
    readyNow: string;
    /** "~{n} min wait" — interpolate {n}. */
    waitMinutesShort: (n: number) => string;
    /** "Ready around {time}" — interpolate {time}. */
    readyAroundTime: string;
    /** Available-now action: bypasses the queue. */
    assignImmediately: string;
    /** "Wait for {name}" — interpolate {name}. */
    waitForStaff: string;
    /** "Other staff" link / button when receptionist wants to revert
     * to Best Match after picking a busy staff. */
    pickAnotherStaff: string;
    heavyLoad: string;
    heavyLoadDetail: string;
    /** Aria label / heading on the availability card. */
    availabilityHeader: string;
    availabilityChecking: string;
    /** "{n} ahead" — interpolate {n}. */
    queueAheadHint: (n: number) => string;
    /** Confidence chip labels. */
    confidenceMedium: string;
    confidenceLow: string;
    /** P0.5: shown inline when receptionist submits in auto-pick mode
     * but the availability engine has zero usable staff (e.g. salon
     * after hours). Form preserves all entered values so they can
     * switch the dropdown to a specific staff without retyping. */
    autoPickNoStaffAvailable: string;
    /** P1.17: unified submit button has a smaller second line that
     * tells the receptionist exactly what will happen when they tap.
     * Templates — interpolate `{name}` for the assign variants. */
    subLabelAssignNow: string;
    subLabelQueue: string;
    subLabelAssignTo: string;
    /** FIX 16 — staff has a group booking starting within
     * `WALKIN_GROUP_BUFFER_MS` (30 min). `{time}` is interpolated
     * with a localized clock-time string. */
    walkinConflictsGroup: string;
    /** "Continue anyway" — keep selection and submit. */
    walkinContinueAnyway: string;
    /** "Choose different staff" — clears `selectedStaffId`. */
    walkinChooseDifferent: string;
    /** Durable create acknowledgement. */
    walkinSaved: string;
    /** Create committed, but the immediate assignment lost a race. */
    walkinSavedAssignmentPending: string;
    /** Connection failed after submit; retry keeps the same request identity. */
    walkinRetrySafe: string;
    relative: {
      justNow: string;
      today: string;
      daysAgo: (n: number) => string;
      weeksAgo: (n: number) => string;
      monthsAgo: (n: number) => string;
    };
  };
  /**
   * Phone lookup hook (parent calls the server action). When provided,
   * the form debounces phone changes and shows a client card on hit.
   * When omitted, the lookup UI is hidden — keeps the form usable
   * outside ReceptionistCenter (storybook, tests).
   */
  onPhoneLookup?: (phone: string) => Promise<ClientLookupResult>;
  /** Async callback — parent calls server action */
  onSubmit: (input: {
    clientName: string;
    clientPhone: string;
    serviceId: string;
    staffRequestNote: string | null;
    /** Explicit "khách yêu cầu thợ này" checkbox. Walk-ins where the
     * note has visible content are also treated as requested server-side.
     * Auto-set by the phone-lookup card when the customer has a
     * top-staff history. */
    staffRequestedByClient: boolean;
    walkinSource: QueueSource | null;
    walkinPriority: QueuePriority | null;
    walkinRequestTags: QueueRequestTag[];
    requestId: string;
    actualArrivalAtIso: string;
  }) => Promise<{
    ok: boolean;
    error?: string;
    assignmentPending?: boolean;
  }>;
  /**
   * Popular service ids derived from today's bookings (server-side).
   * Rendered as shortcut chips above the service grid; tapping a chip
   * snaps `selectedServiceId` to that id. Hidden when undefined or
   * empty.
   */
  popularServiceIds?: ReadonlyArray<string>;
  /** Localized label for the popular chip row. */
  popularServicesLabel?: string;
  /**
   * Active staff for the "Requested staff" dropdown. Empty/omitted
   * hides the smart-availability UI entirely (keeps the form usable
   * outside ReceptionistCenter).
   */
  staffOptions?: ReadonlyArray<{ id: string; name: string }>;
  /**
   * Hook the parent uses to query the availability engine. Called
   * whenever staff or service selection changes. Empty `staffId`
   * means the receptionist picked "Best Match (auto)" — server
   * returns the ranked list and the form recommends the top entry.
   */
  onCheckAvailability?: (input: {
    staffId: string | null;
    serviceId: string;
  }) => Promise<AvailabilityResult>;
  /**
   * Direct-assign path used when the chosen staff is `isAvailableNow`.
   * Creation is authoritative: if assignment loses a race, the result reports
   * `assignmentPending` and the customer remains visible in the queue.
   */
  onAddAndAssign?: (input: {
    clientName: string;
    clientPhone: string;
    serviceId: string;
    staffId: string;
    /** Caller's "now" — keeps form and server in agreement on the
     * start time even with small clock skew. */
    startAtIso: string;
    actualArrivalAtIso: string;
    staffRequestedByClient: boolean;
    staffRequestNote: string | null;
    walkinSource: QueueSource | null;
    walkinPriority: QueuePriority | null;
    walkinRequestTags: QueueRequestTag[];
    requestId: string;
  }) => Promise<{
    ok: boolean;
    error?: string;
    assignmentPending?: boolean;
  }>;
  /**
   * `salons.walkin_auto_assign` (PR #107). When false, the
   * "Assign immediately" button is hidden — every walk-in is added
   * to the queue regardless of staff availability. Defaults to true
   * for backward compatibility with callers that haven't migrated.
   */
  autoAssignEnabled?: boolean;
  /** One-shot prefill for creating a new walk-in from an immutable no-show.
   * `prefillKey` prevents reapplying the archived values after a successful
   * reset or while the receptionist edits the form. */
  initialClientName?: string;
  initialClientPhone?: string;
  initialServiceId?: string;
  prefillKey?: string;
  recoveryNotice?: { title: string; description: string };
  /**
   * Bumped by the parent when the receptionist opens the panel via the
   * dedicated "+ Walk-in" action (vs just toggling the queue list). Each
   * change moves keyboard focus to the name field so they can type
   * immediately — this is what makes "+ Walk-in" feel like an ADD action,
   * distinct from "Hàng chờ" which just shows the waiting list.
   */
  focusNonce?: number;
}

function formatServicePrice(
  priceCents: number,
  currency: import("@/shared/lib/currencyFormat").Currency,
): string {
  return formatCurrency(priceCents, currency) ?? "—";
}

/** Catalog-tile price honouring the service's pricing model
 *  (fixed / from / range). No dashboard `language` is in scope here,
 *  so `fromLabel` is omitted (central formatter defaults to "From"). */
function formatSvc(
  s: { price_cents: number; price_type: string; price_max_cents: number | null },
  currency: import("@/shared/lib/currencyFormat").Currency,
): string {
  return (
    formatServicePriceLabel(s.price_cents, currency, {
      priceType: s.price_type,
      priceMaxCents: s.price_max_cents,
    }) ?? "—"
  );
}

const TOP_SERVICE_COUNT = 6;

const PHONE_LOOKUP_DEBOUNCE_MS = 600;
const PHONE_LOOKUP_MIN_DIGITS = 8;

type LookupState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "found"; phoneMasked: string; profile: ClientLookupProfile }
  | { kind: "not_found" }
  | { kind: "error" };

type AvailabilityState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; staff: StaffAvailability[]; nowIso: string }
  | { kind: "error" };

function formatRelativeShort(
  iso: string,
  now: Date,
  copy: WalkinAddFormProps["labels"]["relative"],
): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diffMs = now.getTime() - t;
  const oneDayMs = 24 * 60 * 60 * 1000;
  const days = Math.floor(diffMs / oneDayMs);
  if (days <= 0) return copy.today;
  if (days < 1) return copy.justNow;
  if (days < 14) return copy.daysAgo(days);
  if (days < 60) return copy.weeksAgo(Math.floor(days / 7));
  return copy.monthsAgo(Math.floor(days / 30));
}

export function WalkinAddForm({
  services,
  currency,
  nowIso,
  timezone,
  labels,
  onSubmit,
  onPhoneLookup,
  disabled = false,
  isOffline = false,
  offlineDisabledHint,
  popularServiceIds,
  popularServicesLabel,
  staffOptions,
  onCheckAvailability,
  onAddAndAssign,
  autoAssignEnabled = true,
  initialClientName,
  initialClientPhone,
  initialServiceId,
  prefillKey,
  recoveryNotice,
  focusNonce,
}: WalkinAddFormProps) {
  const nameId = useId();
  const phoneId = useId();
  const noteId = useId();
  const sourceId = useId();
  const priorityId = useId();
  const tagInputId = useId();
  const actualTimeId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  // Refs (not state) so blur handlers see current value without stale closure issues.
  const nameTouchedRef = useRef(false);
  const phoneTouchedRef = useRef(false);
  // Synchronous in-flight guard against double/multi-submit. The
  // `submitting` state lags one render, so a same-tick double-click (or
  // Enter + click) could fire two server calls before the button's
  // `disabled={submitting}` applies. This ref blocks the 2nd call
  // immediately — no duplicate POST.
  const submittingRef = useRef(false);
  const requestIdentityRef = useRef<{
    requestId: string;
    fingerprint: string;
  } | null>(null);

  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(
    null,
  );
  const [staffRequestNote, setStaffRequestNote] = useState("");
  const [staffRequestedByClient, setStaffRequestedByClient] = useState(false);
  const [showMoreServices, setShowMoreServices] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [actualTimeHm, setActualTimeHm] = useState(() =>
    walkinActualTimeHm(timezone, nowIso),
  );
  const [actualTimeError, setActualTimeError] = useState<string | null>(null);

  // Move focus to the name field when the parent signals an explicit
  // "+ Walk-in" open (focusNonce bumps). Guarded so the initial
  // undefined → no-op; only deliberate opens steal focus.
  useEffect(() => {
    if (!focusNonce) return;
    const raf = requestAnimationFrame(() => {
      setActualTimeHm(walkinActualTimeHm(timezone, new Date().toISOString()));
      setActualTimeError(null);
      nameRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [focusNonce, timezone]);
  // P1.2 — per-field touched gate. We only surface validation errors
  // after the user has interacted with a field (typed into it OR
  // clicked submit). Avoids the "open form → focus moves away →
  // 'Name required' flashes immediately" anti-UX. Submit click flips
  // both to true so the runSubmit-side checks still render their
  // messages.
  const [walkinSource, setWalkinSource] = useState<QueueSource | "">("");
  const [walkinPriority, setWalkinPriority] = useState<QueuePriority | "">("");
  const [requestTags, setRequestTags] = useState<QueueRequestTag[]>([]);
  const [tagDraft, setTagDraft] = useState("");

  // Smart-availability state. Empty `selectedStaffId` means "Best
  // Match (auto)" — the form recommends the top-ranked staff but does
  // not force the receptionist into one until they pick a specific
  // dropdown option.
  const [selectedStaffId, setSelectedStaffId] = useState<string>("");
  const [availability, setAvailability] = useState<AvailabilityState>({
    kind: "idle",
  });
  const availabilityRequestSeqRef = useRef(0);

  // Phone-lookup state — driven by debounced phone changes when the
  // parent passes onPhoneLookup. See `useEffect` block below.
  const [lookup, setLookup] = useState<LookupState>({ kind: "idle" });
  // Track which phone digit-string the lookup result corresponds to,
  // so the card disappears when the user edits to a different number.
  const lookupRequestSeqRef = useRef(0);
  // Snapshot of fields auto-applied from the last lookup. When the
  // user types over them we don't want a stale prefill to keep
  // overwriting their input on every render.
  const autoFilledForPhoneRef = useRef<string | null>(null);

  const appliedPrefillKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!prefillKey || appliedPrefillKeyRef.current === prefillKey) return;
    appliedPrefillKeyRef.current = prefillKey;

    const nextPhone = formatPhoneInputProgressive(initialClientPhone ?? "");
    const phoneValidation = validateGuestPhone(nextPhone);
    setClientName(initialClientName ?? "");
    setClientPhone(nextPhone);
    setSelectedServiceId(
      initialServiceId && services.some((service) => service.id === initialServiceId)
        ? initialServiceId
        : null,
    );
    setStaffRequestNote("");
    setStaffRequestedByClient(false);
    setSelectedStaffId("");
    setErrorMessage(null);
    setNameError(null);
    setPhoneError(null);
    setActualTimeHm(walkinActualTimeHm(timezone, new Date().toISOString()));
    setActualTimeError(null);
    setLookup({ kind: "idle" });
    lookupRequestSeqRef.current += 1;
    nameTouchedRef.current = false;
    phoneTouchedRef.current = false;
    autoFilledForPhoneRef.current = phoneValidation.ok
      ? phoneValidation.digits
      : null;

    const raf = requestAnimationFrame(() => nameRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [
    initialClientName,
    initialClientPhone,
    initialServiceId,
    prefillKey,
    services,
    timezone,
  ]);

  // Offline locks every interactive control except read-only fields,
  // matching the existing `disabled` semantic; the inline hint below
  // the submit gives the receptionist offline-specific copy so they
  // know it's a connection issue rather than a setup state.
  const formLocked = disabled || submitting || isOffline;

  const topServices = useMemo(
    () => services.slice(0, TOP_SERVICE_COUNT),
    [services],
  );
  const extraServices = useMemo(
    () => services.slice(TOP_SERVICE_COUNT),
    [services],
  );

  // Resolve popular ids → catalog rows in the order supplied (which is
  // the server-side frequency rank). Drops ids that no longer exist in
  // the catalog (e.g. a service the owner just deleted between loads).
  const popularServices = useMemo(() => {
    if (!popularServiceIds || popularServiceIds.length === 0) return [];
    const byId = new Map(services.map((s) => [s.id, s] as const));
    const out: typeof services = [];
    for (const id of popularServiceIds) {
      const row = byId.get(id);
      if (row) out.push(row);
    }
    return out;
  }, [popularServiceIds, services]);

  // Debounced phone lookup. Fires only when:
  //   - parent supplied an `onPhoneLookup` (sidebar / center wires it),
  //   - the entered phone passes validation AND has ≥ 8 digits, AND
  //   - the user hasn't typed for PHONE_LOOKUP_DEBOUNCE_MS.
  // Stale-result guard via lookupRequestSeqRef so an in-flight result
  // for an older phone doesn't override a newer one.
  /* eslint-disable react-hooks/set-state-in-effect -- ARCHITECTURE_LOCK: reset/loading states before async phone lookup */
  useEffect(() => {
    if (!onPhoneLookup) return;
    const trimmed = clientPhone.trim();
    if (trimmed.length === 0) {
      setLookup({ kind: "idle" });
      autoFilledForPhoneRef.current = null;
      return;
    }
    const validation = validateGuestPhone(trimmed);
    if (!validation.ok || validation.digits.length < PHONE_LOOKUP_MIN_DIGITS) {
      setLookup({ kind: "idle" });
      autoFilledForPhoneRef.current = null;
      return;
    }

    const targetDigits = validation.digits;
    const seq = ++lookupRequestSeqRef.current;
    const timer = window.setTimeout(async () => {
      setLookup({ kind: "loading" });
      try {
        const result = await onPhoneLookup(trimmed);
        if (lookupRequestSeqRef.current !== seq) return; // stale
        if (!result.ok) {
          setLookup({ kind: "error" });
          return;
        }
        if (result.found) {
          setLookup({
            kind: "found",
            phoneMasked: maskPhonePartial(result.phone),
            profile: result.profile,
          });
          // Auto-fill (only once per phone — don't fight the user's
          // edits on subsequent renders).
          if (autoFilledForPhoneRef.current !== targetDigits) {
            autoFilledForPhoneRef.current = targetDigits;
            const profileName = result.profile.name?.trim() ?? "";
            if (profileName) setClientName(profileName);
            if (result.profile.top_service?.id) {
              setSelectedServiceId(result.profile.top_service.id);
            }
            if (result.profile.top_staff?.id) {
              setStaffRequestedByClient(true);
            }
          }
        } else {
          setLookup({ kind: "not_found" });
          autoFilledForPhoneRef.current = null;
        }
      } catch {
        if (lookupRequestSeqRef.current !== seq) return;
        setLookup({ kind: "error" });
      }
    }, PHONE_LOOKUP_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [clientPhone, onPhoneLookup]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Smart availability: refresh whenever staff selection or service
  // changes. The seq guard prevents an in-flight result for an old
  // pair from clobbering a newer one.
  /* eslint-disable react-hooks/set-state-in-effect -- ARCHITECTURE_LOCK: reset/loading states before async availability check */
  useEffect(() => {
    if (!onCheckAvailability) return;
    if (!selectedServiceId) {
      setAvailability({ kind: "idle" });
      return;
    }

    const seq = ++availabilityRequestSeqRef.current;
    setAvailability({ kind: "loading" });

    const run = async () => {
      try {
        const r = await onCheckAvailability({
          staffId: selectedStaffId === "" ? null : selectedStaffId,
          serviceId: selectedServiceId,
        });
        if (seq !== availabilityRequestSeqRef.current) return;
        if (!r.ok) {
          setAvailability({ kind: "error" });
          return;
        }
        setAvailability({
          kind: "ready",
          staff: r.staff,
          nowIso: r.nowIso,
        });
      } catch (e) {
        console.error("[WalkinAddForm] onCheckAvailability", e);
        if (seq !== availabilityRequestSeqRef.current) return;
        setAvailability({ kind: "error" });
      }
    };
    void run();
  }, [onCheckAvailability, selectedStaffId, selectedServiceId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const resetAfterSuccess = useCallback(() => {
    setClientName("");
    setClientPhone("");
    setSelectedServiceId(null);
    setStaffRequestNote("");
    setStaffRequestedByClient(false);
    setShowMoreServices(false);
    setShowDetails(false);
    setErrorMessage(null);
    setNameError(null);
    setPhoneError(null);
    setActualTimeHm(walkinActualTimeHm(timezone, new Date().toISOString()));
    setActualTimeError(null);
    nameTouchedRef.current = false;
    phoneTouchedRef.current = false;
    setWalkinSource("");
    setWalkinPriority("");
    setRequestTags([]);
    setTagDraft("");
    setLookup({ kind: "idle" });
    autoFilledForPhoneRef.current = null;
    // Invalidate any in-flight phone lookup so a late-resolving result for the
    // just-submitted phone can't re-`setClientName`/`setSelectedServiceId` onto
    // the freshly-cleared form. The submitted walk-in upserts a client_profile
    // for that phone, so a lookup started before reset would otherwise auto-fill
    // the next blank form with the previous customer's name (and flake the
    // queue reset E2E). Mirrors the availability seq bump below.
    lookupRequestSeqRef.current += 1;
    setSelectedStaffId("");
    setAvailability({ kind: "idle" });
    availabilityRequestSeqRef.current += 1;
    requestIdentityRef.current = null;
    queueMicrotask(() => nameRef.current?.focus());
  }, [timezone]);

  const addTag = useCallback(() => {
    const t = tagDraft.trim();
    if (t.length === 0) return;
    if (t.length > QUEUE_REQUEST_TAG_MAX_LEN) return;
    setRequestTags((prev) => {
      if (prev.length >= QUEUE_REQUEST_TAGS_MAX_COUNT) return prev;
      if (prev.includes(t)) return prev;
      return [...prev, t];
    });
    setTagDraft("");
  }, [tagDraft]);

  const removeTag = useCallback((tag: QueueRequestTag) => {
    setRequestTags((prev) => prev.filter((t) => t !== tag));
  }, []);

  // Project the complete service + cleanup buffer through each technician's
  // future reservations. Being idle this second is not enough: the walk-in
  // must fit before the next appointment. In auto mode, skip a ranked candidate
  // whose immediate gap is too short and select the next safe technician.
  const recommendedAvailability = useMemo<StaffAvailability | null>(() => {
    if (
      availability.kind !== "ready" ||
      availability.staff.length === 0 ||
      selectedServiceId === null
    ) {
      return null;
    }
    const selectedService = services.find(
      (service) => service.id === selectedServiceId,
    );
    if (!selectedService) return null;
    return selectWalkinGapSafeRecommendation(
      availability.staff,
      availability.nowIso,
      selectedService,
      selectedStaffId,
    );
  }, [availability, selectedServiceId, selectedStaffId, services]);

  // Task #04-D FIX 16 — detect "this staff has a group booking
  // starting in the next 30 min". Only fires when the receptionist
  // explicitly picked a staff (auto / Best Match already ranks
  // busy-soon staff lower so the auto path doesn't need a warning).
  // Returns the localized clock-time of the imminent group booking
  // so the warning can interpolate `{time}`; null means "no
  // imminent group booking — render nothing".
  const imminentGroupBookingTime = useMemo<string | null>(() => {
    if (selectedStaffId === "") return null;
    if (!recommendedAvailability) return null;
    const ng = recommendedAvailability.nextGroupBookingAt;
    if (!ng) return null;
    const ngMs = Date.parse(ng);
    if (!Number.isFinite(ngMs)) return null;
    // eslint-disable-next-line react-hooks/purity -- ARCHITECTURE_LOCK: Date.now() fallback is intentional; availability.nowIso is preferred but may not be ready
    const nowFallback = Date.now();
    const nowMs = availability.kind === "ready" ? Date.parse(availability.nowIso) : nowFallback;
    if (ngMs - nowMs > WALKIN_GROUP_BUFFER_MS) return null;
    return new Date(ngMs).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  }, [recommendedAvailability, selectedStaffId, availability]);

  // The "Assign immediately" affordance is only offered when the
  // engine has a confident answer AND the parent wired the direct-
  // assign callback AND the salon-level `walkin_auto_assign` setting
  // is enabled. Falling back to the queue keeps the form usable even
  // when the engine is unreachable.
  const canAssignImmediately =
    autoAssignEnabled &&
    !!onAddAndAssign &&
    !!recommendedAvailability &&
    recommendedAvailability.isAvailableNow;

  const runSubmit = useCallback(
    async (mode: "queue" | "immediate") => {
      if (disabled) return;
      // Ignore duplicate submits while one is already in flight (sync ref;
      // beats the batched `submitting` state, which lags a render).
      if (submittingRef.current) return;
      // P1.2 — clicking submit counts as "intent to use the field",
      // so any per-field validators below should always render their
      // messages regardless of whether the user blurred first.
      nameTouchedRef.current = true;
      phoneTouchedRef.current = true;
      const trimmedName = clientName.trim();
      if (trimmedName.length === 0) {
        setNameError(labels.nameRequired);
        queueMicrotask(() => nameRef.current?.focus());
        return;
      }
      if (trimmedName.length > BOOKING_GUEST_NAME_MAX) {
        setNameError(labels.nameTooLong);
        queueMicrotask(() => nameRef.current?.focus());
        return;
      }
      if (!isValidCustomerName(trimmedName)) {
        setNameError(labels.invalidNameChars);
        queueMicrotask(() => nameRef.current?.focus());
        return;
      }
      const trimmedPhone = clientPhone.trim();
      if (trimmedPhone.length === 0) {
        setPhoneError(labels.phoneRequired);
        queueMicrotask(() => phoneRef.current?.focus());
        return;
      }
      const phoneValidation = validateGuestPhone(trimmedPhone);
      if (!phoneValidation.ok) {
        setPhoneError(labels.invalidPhone);
        queueMicrotask(() => phoneRef.current?.focus());
        return;
      }
      if (selectedServiceId === null) {
        setErrorMessage(labels.errorRequired);
        return;
      }
      const actualTime = resolveWalkinActualTime(
        actualTimeHm,
        timezone,
        new Date().toISOString(),
      );
      if (!actualTime.ok) {
        setActualTimeError(labels.actualTimeInvalid);
        return;
      }

      // P0.5 — Auto-pick + no available staff (e.g. after hours).
      // Without this guard the form silently falls through to the
      // queue path; the receptionist sees a success toast but the
      // walk-in is invisibly parked, and they don't realize they
      // need to assign a specific staff. We require staff selection
      // in this state instead of submitting anything.
      if (
        mode === "queue" &&
        selectedStaffId === "" &&
        !!onCheckAvailability &&
        !!staffOptions &&
        staffOptions.length > 0 &&
        availability.kind === "ready" &&
        availability.staff.length === 0
      ) {
        setErrorMessage(labels.autoPickNoStaffAvailable);
        return;
      }

      setErrorMessage(null);
      setSuccessMessage(null);
      setNameError(null);
      setPhoneError(null);
      setActualTimeError(null);

      const normalizedNote = staffRequestNote.trim() || null;
      const requestFingerprint = JSON.stringify({
        clientName: trimmedName,
        clientPhone: phoneValidation.digits,
        serviceId: selectedServiceId,
        staffRequestNote: normalizedNote,
        staffRequestedByClient,
        walkinSource: walkinSource || null,
        walkinPriority: walkinPriority || null,
        walkinRequestTags: requestTags,
        actualArrivalAtIso: actualTime.actualTimeIso,
      });
      if (requestIdentityRef.current?.fingerprint !== requestFingerprint) {
        requestIdentityRef.current = {
          requestId: crypto.randomUUID(),
          fingerprint: requestFingerprint,
        };
      }
      const requestId = requestIdentityRef.current.requestId;

      submittingRef.current = true;
      setSubmitting(true);
      try {
        let result: {
          ok: boolean;
          error?: string;
          assignmentPending?: boolean;
        };
        if (
          mode === "immediate" &&
          onAddAndAssign &&
          recommendedAvailability &&
          recommendedAvailability.isAvailableNow
        ) {
          result = await onAddAndAssign({
            clientName: trimmedName,
            clientPhone: trimmedPhone,
            serviceId: selectedServiceId,
            staffId: recommendedAvailability.staffId,
            startAtIso:
              actualTime.actualTimeIso,
            actualArrivalAtIso: actualTime.actualTimeIso,
            // Honor the actual checkbox (auto-set true for returning customers
            // with a usual tech via the lookup). Hardcoding true here flagged
            // EVERY immediately-assigned walk-in as a ❤️ staff request the guest
            // never made (QA ReceptionistCenter ReTest2/3); the #384 server-side
            // default fix was overridden by this client value.
            staffRequestedByClient,
            staffRequestNote: normalizedNote,
            walkinSource: walkinSource === "" ? null : walkinSource,
            walkinPriority: walkinPriority === "" ? null : walkinPriority,
            walkinRequestTags: requestTags,
            requestId,
          });
        } else {
          result = await onSubmit({
            clientName: trimmedName,
            clientPhone: trimmedPhone,
            serviceId: selectedServiceId,
            staffRequestNote: normalizedNote,
            staffRequestedByClient,
            walkinSource: walkinSource === "" ? null : walkinSource,
            walkinPriority: walkinPriority === "" ? null : walkinPriority,
            walkinRequestTags: requestTags,
            requestId,
            actualArrivalAtIso: actualTime.actualTimeIso,
          });
        }

        if (result.ok) {
          resetAfterSuccess();
          setSuccessMessage(
            result.assignmentPending
              ? labels.walkinSavedAssignmentPending
              : labels.walkinSaved,
          );
        } else {
          setErrorMessage(result.error ?? labels.errorRequired);
        }
      } catch {
        // The server may have committed before the response was lost. Keep the
        // form and request identity intact so retry reads the canonical booking.
        setErrorMessage(labels.walkinRetrySafe);
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [
      clientName,
      clientPhone,
      labels.errorRequired,
      labels.nameRequired,
      labels.nameTooLong,
      labels.invalidNameChars,
      labels.invalidPhone,
      labels.phoneRequired,
      labels.actualTimeInvalid,
      labels.autoPickNoStaffAvailable,
      labels.walkinSaved,
      labels.walkinSavedAssignmentPending,
      labels.walkinRetrySafe,
      onSubmit,
      onAddAndAssign,
      onCheckAvailability,
      recommendedAvailability,
      availability,
      resetAfterSuccess,
      selectedServiceId,
      selectedStaffId,
      staffOptions,
      staffRequestNote,
      staffRequestedByClient,
      walkinSource,
      walkinPriority,
      requestTags,
      actualTimeHm,
      timezone,
      disabled,
    ],
  );

  useEffect(() => {
    if (!disabled) nameRef.current?.focus();
  }, [disabled]);

  const onNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Ignore Enter while a Vietnamese IME composition is active — it commits
    // the word; advancing focus here would strand the last word in the field.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (clientPhone.trim().length === 0) {
        document
          .getElementById(`walkin-service-${topServices[0]?.id ?? ""}`)
          ?.focus();
      } else {
        phoneRef.current?.focus();
      }
    }
  };

  const onPhoneKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document
        .getElementById(`walkin-service-${topServices[0]?.id ?? ""}`)
        ?.focus();
    }
  };

  const onNoteKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Don't submit mid-IME-composition (Vietnamese note text).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void runSubmit(canAssignImmediately ? "immediate" : "queue");
    }
    if (e.key === "Escape") {
      setErrorMessage(null);
      setNameError(null);
      setPhoneError(null);
    }
  };

  const onTagInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Don't add a tag mid-IME-composition (Vietnamese tag text).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      addTag();
    }
  };

  const onPriorityKeyDown = (e: React.KeyboardEvent<HTMLSelectElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitRef.current?.focus();
      void runSubmit(canAssignImmediately ? "immediate" : "queue");
    }
  };

  const onFormKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if (e.key === "Escape") {
      setErrorMessage(null);
      setNameError(null);
      setPhoneError(null);
    }
    // Cmd/Ctrl + Enter from any field submits the form. Reception speed
    // path: the form's other key handlers advance field-by-field; this
    // shortcut bypasses the chain when the receptionist already knows
    // every field is filled (the existing per-field validators still
    // run inside `runSubmit`, so missing required values still surface).
    if (
      e.key === "Enter" &&
      (e.metaKey || e.ctrlKey) &&
      !formLocked
    ) {
      e.preventDefault();
      void runSubmit(canAssignImmediately ? "immediate" : "queue");
    }
  };

  const tagsAtCap = requestTags.length >= QUEUE_REQUEST_TAGS_MAX_COUNT;

  return (
    <form
      data-testid="walkin-add-form"
      className={cn(
        "space-y-3 border-b border-nq-muted/20 pb-4",
        disabled && "opacity-55",
      )}
      onSubmit={(e) => {
        e.preventDefault();
        void runSubmit(canAssignImmediately ? "immediate" : "queue");
      }}
      onKeyDown={onFormKeyDown}
    >
      {prefillKey && recoveryNotice ? (
        <div
          data-testid="walkin-recovery-notice"
          className="rounded-lg border border-nq-primary/30 bg-nq-primary/10 p-3"
        >
          <p className="text-base font-semibold text-nq-foreground">
            {recoveryNotice.title}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-nq-muted">
            {recoveryNotice.description}
          </p>
        </div>
      ) : null}
      <div className="space-y-2">
        <label htmlFor={nameId} className="sr-only">
          {labels.namePlaceholder}
        </label>
        <input
          id={nameId}
          ref={nameRef}
          type="text"
          data-testid="walkin-name"
          autoComplete="name"
          disabled={formLocked}
          placeholder={labels.namePlaceholder}
          value={clientName}
          maxLength={BOOKING_GUEST_NAME_MAX}
          onChange={(e) => {
            setClientName(e.target.value);
            setNameError(null);
            // Typing into a field counts as the user "engaging" with
            // it for P1.2 — from now on blur-validation will surface
            // errors. This avoids the "open form → focus moves
            // away → error flashes immediately" anti-UX before any
            // typing has happened.
            nameTouchedRef.current = true;
          }}
          onBlur={() => {
            const t = clientName.trim();
            setClientName(t);
            // P1.2 — only surface validation on blur once the user
            // has actually typed something. If the receptionist
            // tabs through the form without touching name, we stay
            // silent.
            if (!nameTouchedRef.current) return;
            if (t.length === 0) {
              setNameError(labels.nameRequired);
            } else if (t.length > BOOKING_GUEST_NAME_MAX) {
              setNameError(labels.nameTooLong);
            } else if (!isValidCustomerName(t)) {
              setNameError(labels.invalidNameChars);
            } else {
              setNameError(null);
            }
          }}
          onKeyDown={onNameKeyDown}
          aria-invalid={Boolean(nameError)}
          className={cn(
            "h-11 w-full rounded-lg border bg-nq-bg px-3 text-base text-nq-foreground placeholder:text-nq-muted focus:outline-none focus:ring-2 focus:ring-nq-primary/35",
            nameError
              ? "border-nq-error/50 focus:border-nq-error/60"
              : "border-nq-muted/35 focus:border-nq-primary",
            formLocked && "opacity-60",
          )}
        />
        {nameError ? (
          <p
            className="text-base text-nq-error"
            role="alert"
            data-testid="walkin-name-error"
          >
            {nameError}
          </p>
        ) : null}
        <label htmlFor={phoneId} className="sr-only">
          {labels.phonePlaceholder}
        </label>
        <input
          id={phoneId}
          ref={phoneRef}
          type="tel"
          autoComplete="tel"
          disabled={formLocked}
          placeholder={labels.phonePlaceholder}
          value={clientPhone}
          maxLength={24}
          onChange={(e) => {
            // P2.6 — live-format NANP numbers so receptionists see
            // "(604) 555-…" while typing rather than the raw digits.
            setClientPhone(formatPhoneInputProgressive(e.target.value));
            setPhoneError(null);
            // P1.2 — see name field for rationale.
            phoneTouchedRef.current = true;
          }}
          onBlur={() => {
            const p = clientPhone.trim();
            setClientPhone(p);
            // P1.2 — silent until the field has been engaged.
            if (!phoneTouchedRef.current) return;
            if (p.length === 0) {
              setPhoneError(null);
              return;
            }
            setPhoneError(
              validateGuestPhone(p).ok ? null : labels.invalidPhone,
            );
          }}
          onKeyDown={onPhoneKeyDown}
          aria-invalid={Boolean(phoneError)}
          data-testid="walkin-phone"
          className={cn(
            "h-11 w-full rounded-lg border bg-nq-bg px-3 text-base text-nq-foreground placeholder:text-nq-muted focus:outline-none focus:ring-2 focus:ring-nq-primary/35",
            phoneError
              ? "border-nq-error/50 focus:border-nq-error/60"
              : "border-nq-muted/35 focus:border-nq-primary",
            formLocked && "opacity-60",
          )}
        />
        {phoneError ? (
          <p
            className="text-base text-nq-error"
            role="alert"
            data-testid="walkin-phone-error"
          >
            {phoneError}
          </p>
        ) : null}

        {onPhoneLookup && lookup.kind === "loading" ? (
          <p
            role="status"
            aria-label={labels.lookupLoadingAria}
            className="inline-flex items-center gap-1.5 text-base text-nq-muted"
            data-testid="walkin-phone-lookup-loading"
          >
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-nq-primary/80"
            />
            {labels.lookupLoading}
          </p>
        ) : null}

        {onPhoneLookup && lookup.kind === "not_found" ? (
          <p
            className="rounded-md border border-nq-info/35 bg-nq-info/10 px-3 py-2 text-base text-nq-foreground"
            data-testid="walkin-phone-lookup-newcustomer"
          >
            {labels.newCustomer}
          </p>
        ) : null}

        {onPhoneLookup && lookup.kind === "found" ? (
          <ClientLookupCard
            phoneMasked={lookup.phoneMasked}
            profile={lookup.profile}
            labels={labels}
            currency={currency}
          />
        ) : null}

        <div>
          <label
            htmlFor={actualTimeId}
            className="mb-1 block text-base font-medium text-nq-muted"
          >
            {labels.actualTimeLabel}
          </label>
          <input
            id={actualTimeId}
            type="time"
            step={60}
            data-testid="walkin-actual-time"
            disabled={formLocked}
            value={actualTimeHm}
            onChange={(event) => {
              const nextActualTimeHm = event.target.value;
              const nextActualTime = resolveWalkinActualTime(
                nextActualTimeHm,
                timezone,
                new Date().toISOString(),
              );
              setActualTimeHm(nextActualTimeHm);
              setActualTimeError(
                nextActualTime.ok ? null : labels.actualTimeInvalid,
              );
            }}
            aria-invalid={Boolean(actualTimeError)}
            className={cn(
              "h-11 w-full rounded-lg border bg-nq-bg px-3 text-base text-nq-foreground focus:outline-none focus:ring-2 focus:ring-nq-primary/35",
              actualTimeError
                ? "border-nq-error/50 focus:border-nq-error/60"
                : "border-nq-muted/35 focus:border-nq-primary",
              formLocked && "opacity-60",
            )}
          />
          <p className="mt-1 text-sm text-nq-muted">{labels.actualTimeHint}</p>
          {actualTimeError ? (
            <p
              role="alert"
              data-testid="walkin-actual-time-error"
              className="mt-1 text-base text-nq-error"
            >
              {actualTimeError}
            </p>
          ) : null}
        </div>
      </div>

      {popularServices.length > 0 ? (
        <div
          data-testid="walkin-popular-services"
          className="space-y-1"
        >
          {popularServicesLabel ? (
            <p className="text-base font-semibold text-nq-muted">
              {popularServicesLabel}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {popularServices.map((s) => {
              const selected = selectedServiceId === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  data-testid={`walkin-popular-${s.id}`}
                  disabled={formLocked}
                  onClick={() => setSelectedServiceId(s.id)}
                  className={cn(
                    "inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full border px-3 py-2 text-base font-medium transition-colors",
                    selected
                      ? "border-nq-primary bg-nq-primary/15 text-nq-primary"
                      : "border-nq-border bg-nq-surface/60 text-nq-foreground hover:border-nq-primary/40",
                    formLocked && "opacity-60",
                  )}
                >
                  <span aria-hidden>★</span>
                  <span className="truncate">{s.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {topServices.map((s) => {
            const selected = selectedServiceId === s.id;
            return (
              <button
                key={s.id}
                id={`walkin-service-${s.id}`}
                type="button"
                disabled={formLocked}
                onClick={() => setSelectedServiceId(s.id)}
                className={cn(
                  "flex min-h-16 flex-col items-start justify-center rounded-lg border px-2.5 py-2 text-left text-base transition-[border-color,background-color] duration-[var(--duration-nq-fast,150ms)]",
                  selected
                    ? "border-nq-primary bg-nq-primary/12 text-nq-foreground"
                    : "border-nq-muted/35 bg-nq-surface text-nq-foreground hover:border-nq-muted",
                  formLocked && "opacity-60",
                )}
              >
                <span className="line-clamp-2 font-semibold leading-snug">
                  {s.name}
                </span>
                <span className="mt-0.5 font-mono text-base text-nq-muted">
                  {s.duration_minutes}m · {formatSvc(s, currency)}
                </span>
              </button>
            );
          })}
        </div>
        {extraServices.length > 0 && (
          <>
            <button
              type="button"
              disabled={formLocked}
              onClick={() => setShowMoreServices((v) => !v)}
              className={cn(
                "min-h-11 text-base font-medium text-nq-primary hover:text-nq-primary/90",
                formLocked && "pointer-events-none opacity-60",
              )}
            >
              {labels.moreServices}
            </button>
            {showMoreServices && (
              <ul
                className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-nq-muted/25 bg-nq-bg p-1"
                role="listbox"
              >
                {extraServices.map((s) => {
                  const selected = selectedServiceId === s.id;
                  return (
                    <li key={s.id} role="none">
                      <button
                        type="button"
                        disabled={formLocked}
                        onClick={() => setSelectedServiceId(s.id)}
                        className={cn(
                          "flex min-h-11 w-full flex-col items-start rounded-md px-2 py-2 text-left text-base",
                          selected
                            ? "bg-nq-primary/15 text-nq-primary"
                            : "text-nq-foreground hover:bg-nq-muted/15",
                        )}
                      >
                        <span className="font-medium">{s.name}</span>
                        <span className="font-mono text-base text-nq-muted">
                          {s.duration_minutes}m ·{" "}
                          {formatSvc(s, currency)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>

      <button
        type="button"
        data-testid="walkin-details-toggle"
        aria-expanded={showDetails}
        aria-controls="walkin-optional-details"
        disabled={formLocked}
        onClick={() => setShowDetails((current) => !current)}
        className={cn(
          "flex min-h-11 w-full items-center justify-between rounded-lg border border-nq-muted/30 bg-nq-surface px-3 py-2 text-left text-base font-medium text-nq-foreground transition-colors hover:border-nq-primary/45",
          formLocked && "opacity-60",
        )}
      >
        <span>{showDetails ? labels.hideDetails : labels.moreDetails}</span>
        <span aria-hidden>{showDetails ? "−" : "+"}</span>
      </button>

      {showDetails ? (
      <div
        id="walkin-optional-details"
        data-testid="walkin-optional-details"
        className="space-y-3"
      >
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label
            htmlFor={sourceId}
            className="mb-1 block text-base font-medium text-nq-muted"
          >
            {labels.sourceLabel}
          </label>
          <select
            id={sourceId}
            data-testid="walkin-source"
            disabled={formLocked}
            value={walkinSource}
            onChange={(e) =>
              setWalkinSource((e.target.value || "") as QueueSource | "")
            }
            className={cn(
              "min-h-11 w-full rounded-lg border border-nq-muted/35 bg-nq-bg px-2 text-base text-nq-foreground focus:outline-none focus:ring-2 focus:ring-nq-primary/35",
              formLocked && "opacity-60",
            )}
          >
            <option value="">—</option>
            {QUEUE_SOURCES.map((src) => (
              <option key={src} value={src}>
                {labels.sourceOptions[src]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor={priorityId}
            className="mb-1 block text-base font-medium text-nq-muted"
          >
            {labels.priorityLabel}
          </label>
          <select
            id={priorityId}
            data-testid="walkin-priority"
            disabled={formLocked}
            value={walkinPriority}
            onChange={(e) =>
              setWalkinPriority(
                (e.target.value || "") as QueuePriority | "",
              )
            }
            onKeyDown={onPriorityKeyDown}
            className={cn(
              "min-h-11 w-full rounded-lg border border-nq-muted/35 bg-nq-bg px-2 text-base text-nq-foreground focus:outline-none focus:ring-2 focus:ring-nq-primary/35",
              formLocked && "opacity-60",
            )}
          >
            <option value="">—</option>
            {QUEUE_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {labels.priorityOptions[p]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label
          htmlFor={tagInputId}
          className="mb-1 block text-base font-medium text-nq-muted"
        >
          {labels.requestTagsLabel}
        </label>
        <div className="flex gap-2">
          <input
            id={tagInputId}
            data-testid="walkin-request-tag-input"
            type="text"
            disabled={formLocked || tagsAtCap}
            placeholder={labels.requestTagsPlaceholder}
            value={tagDraft}
            maxLength={QUEUE_REQUEST_TAG_MAX_LEN}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={onTagInputKeyDown}
            className={cn(
              "min-h-11 flex-1 rounded-lg border border-nq-muted/35 bg-nq-bg px-3 text-base text-nq-foreground placeholder:text-nq-muted focus:outline-none focus:ring-2 focus:ring-nq-primary/35",
              (formLocked || tagsAtCap) && "opacity-60",
            )}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={
              formLocked || tagsAtCap || tagDraft.trim().length === 0
            }
            onClick={addTag}
            className="min-h-11 text-base"
          >
            {labels.requestTagAdd}
          </Button>
        </div>
        {requestTags.length > 0 ? (
          <ul
            className="mt-2 flex flex-wrap gap-1.5"
            data-testid="walkin-request-tags-list"
            aria-label={labels.requestTagsLabel}
          >
            {requestTags.map((tag) => (
              <li key={tag}>
                <button
                  type="button"
                  data-testid={`walkin-request-tag-remove-${tag}`}
                  disabled={formLocked}
                  onClick={() => removeTag(tag)}
                  aria-label={labels.requestTagRemove(tag)}
                  className="inline-flex min-h-11 items-center gap-1 rounded-full border border-nq-border bg-nq-surface/60 px-3 py-2 text-base text-nq-foreground hover:border-nq-primary/40"
                >
                  <span>{tag}</span>
                  <span aria-hidden>×</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      </div>
      ) : null}

      {staffOptions && staffOptions.length > 0 && onCheckAvailability ? (
        <div className="space-y-1.5">
          <label
            htmlFor="walkin-requested-staff"
            className="text-base font-semibold text-nq-muted"
          >
            {labels.requestedStaffLabel}
          </label>
          <select
            id="walkin-requested-staff"
            data-testid="walkin-requested-staff"
            disabled={formLocked}
            value={selectedStaffId}
            onChange={(e) => setSelectedStaffId(e.target.value)}
            className={cn(
              "h-11 w-full rounded-lg border border-nq-muted/35 bg-nq-bg px-3 text-base text-nq-foreground focus:border-nq-primary focus:outline-none focus:ring-2 focus:ring-nq-primary/35",
              formLocked && "opacity-60",
            )}
          >
            <option value="">{labels.bestMatchOption}</option>
            {staffOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {selectedServiceId !== null ? (
            <AvailabilityCard
              state={availability}
              recommended={recommendedAvailability}
              isAutoMatch={selectedStaffId === ""}
              labels={labels}
              onResetToBestMatch={() => setSelectedStaffId("")}
            />
          ) : null}
          {imminentGroupBookingTime && recommendedAvailability ? (
            <div
              role="status"
              data-testid="walkin-group-conflict-warning"
              data-group-time={imminentGroupBookingTime}
              className="space-y-2 rounded-md border border-amber-500/55 bg-amber-500/10 px-3 py-2 text-base text-nq-foreground ring-1 ring-amber-400/35"
            >
              <p>
                <span aria-hidden>⚠️ </span>
                {labels.walkinConflictsGroup
                  .replace("{name}", recommendedAvailability.staffName)
                  .replace("{time}", imminentGroupBookingTime)}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid="walkin-group-conflict-continue"
                  onClick={() => {
                    /* no-op — leaves selection intact, receptionist
                     * proceeds with submit as normal. The button
                     * exists to make the "I read this and chose to
                     * continue" explicit. */
                  }}
                  className="min-h-11 rounded-md border border-amber-500/55 bg-nq-bg px-3 py-2 text-base font-semibold text-nq-foreground hover:bg-nq-surface focus:outline-none focus:ring-2 focus:ring-amber-400/45"
                >
                  {labels.walkinContinueAnyway}
                </button>
                <button
                  type="button"
                  data-testid="walkin-group-conflict-reset"
                  onClick={() => setSelectedStaffId("")}
                  className="min-h-11 rounded-md border border-nq-muted/35 bg-nq-bg px-3 py-2 text-base font-semibold text-nq-foreground hover:bg-nq-surface focus:outline-none focus:ring-2 focus:ring-nq-primary/35"
                >
                  {labels.walkinChooseDifferent}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div>
        <label htmlFor={noteId} className="sr-only">
          {labels.notePlaceholder}
        </label>
        <textarea
          id={noteId}
          disabled={formLocked}
          placeholder={labels.notePlaceholder}
          value={staffRequestNote}
          onChange={(e) => setStaffRequestNote(e.target.value)}
          onKeyDown={onNoteKeyDown}
          rows={2}
          className={cn(
            "w-full resize-none rounded-lg border border-nq-muted/35 bg-nq-bg px-3 py-2 text-base text-nq-foreground placeholder:text-nq-muted focus:border-nq-primary focus:outline-none focus:ring-2 focus:ring-nq-primary/35",
            formLocked && "opacity-60",
          )}
        />
      </div>

      <label
        className={cn(
          "flex min-h-11 cursor-pointer items-center gap-2 text-base text-nq-foreground",
          formLocked && "opacity-60",
        )}
      >
        <input
          type="checkbox"
          checked={staffRequestedByClient}
          onChange={(e) => setStaffRequestedByClient(e.target.checked)}
          disabled={formLocked}
          data-testid="walkin-requested-by-client"
          className="size-5 shrink-0 cursor-pointer accent-nq-primary"
        />
        <span className="leading-snug">{labels.staffRequestedByClient}</span>
      </label>

      {errorMessage ? (
        <p className="text-sm text-nq-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      {successMessage ? (
        <p
          className="rounded-md border border-emerald-400/50 bg-emerald-400/10 px-3 py-2 text-sm font-semibold text-emerald-700"
          role="status"
          data-testid="walkin-submit-success"
        >
          {successMessage}
        </p>
      ) : null}

      {isOffline && offlineDisabledHint ? (
        <p
          className="text-base font-semibold text-nq-error"
          role="status"
          data-testid="walkin-offline-hint"
        >
          {offlineDisabledHint}
        </p>
      ) : null}

      <Button
        ref={submitRef}
        type="submit"
        variant="primary"
        size="lg"
        loading={submitting}
        disabled={
          disabled ||
          submitting ||
          isOffline ||
          !!nameError ||
          !!phoneError ||
          !!actualTimeError
        }
        // Soft-disabled (still clickable) while required fields are missing,
        // so a tap surfaces the validation error + focuses the field. Hard
        // `disabled` above remains for submitting / offline / active errors.
        aria-disabled={
          formLocked ||
          !!nameError ||
          !!phoneError ||
          !!actualTimeError ||
          clientName.trim().length === 0 ||
          selectedServiceId === null
            ? true
            : undefined
        }
        title={isOffline ? offlineDisabledHint : undefined}
        className="w-full sm:w-full aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
        data-testid="walkin-submit"
        data-walkin-mode={canAssignImmediately ? "immediate" : "queue"}
      >
        {submitting ? (
          labels.submitting
        ) : (
          // P1.17 — the main label is constant ("Add customer") so the
          // button doesn't shift wording between renders. The smaller
          // second line tells the receptionist exactly what will
          // happen on tap: assign now to {name}, assign to {name}
          // (busy), or fall back to the queue.
          <span
            className="inline-flex flex-col items-center leading-tight"
            data-testid="walkin-submit-label"
          >
            <span>{labels.addButton}</span>
            <span
              className="text-base font-normal opacity-80"
              data-testid="walkin-submit-sublabel"
            >
              {/* Honest binary: the tap either assigns immediately (only when the
                  engine confirms the staff is free now) or adds to the waiting
                  list. The old "Assign to {name}" middle state lied — when the
                  staff is busy the action is ALWAYS the queue path (onSubmit),
                  yet it read like a direct assignment (QA #2). */}
              {canAssignImmediately && recommendedAvailability
                ? labels.subLabelAssignNow.replace(
                    "{name}",
                    recommendedAvailability.staffName,
                  )
                : labels.subLabelQueue}
            </span>
          </span>
        )}
      </Button>

      {/* M9: the submit button is soft-disabled (dimmed but still tappable) while
          required fields are missing — a tap focuses the gap. Without a hint it
          reads as "broken", so spell out what's needed. */}
      {!submitting &&
      !isOffline &&
      (clientName.trim().length === 0 || selectedServiceId === null) ? (
        <p className="mt-1.5 text-center text-base text-nq-muted" data-testid="walkin-incomplete-hint">
          {labels.incompleteHint}
        </p>
      ) : null}
    </form>
  );
}

function ClientLookupCard({
  phoneMasked,
  profile,
  labels,
  currency,
}: {
  phoneMasked: string;
  profile: ClientLookupProfile;
  labels: WalkinAddFormProps["labels"];
  currency: Currency;
}) {
  const now = new Date();
  const lastVisitText = profile.last_visit_at
    ? formatRelativeShort(profile.last_visit_at, now, labels.relative)
    : null;
  const totalSpent = formatServicePrice(profile.total_spent_cents, currency);
  const summary = labels.profileSummary
    .replace("{count}", String(profile.visit_count))
    .replace("{total}", totalSpent);
  const noteIsWarning =
    !!profile.notes && profile.notes.includes("⚠️");

  return (
    <div
      role="status"
      data-testid="walkin-phone-lookup-card"
      className={cn(
        "mt-1 space-y-1 rounded-md border bg-nq-surface px-2.5 py-2 text-xs text-nq-foreground",
        profile.is_vip
          ? "border-amber-400/60 ring-1 ring-amber-300/40"
          : "border-nq-muted/35",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-semibold">
            {profile.name?.trim() || labels.returningCustomerHeader}
          </span>
          {profile.is_vip ? (
            <span
              data-testid="walkin-phone-lookup-vip"
              className="inline-flex items-center rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700"
            >
              {labels.vipBadge}
            </span>
          ) : null}
        </div>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-nq-muted">
          {phoneMasked}
        </span>
      </div>
      <p className="text-[11px] text-nq-muted">{summary}</p>
      {lastVisitText ? (
        <p className="text-[11px] text-nq-muted">
          {labels.lastVisitLine.replace("{date}", lastVisitText)}
        </p>
      ) : null}
      {profile.top_service ? (
        <p className="text-[11px] text-nq-muted">
          {labels.usualServiceLine.replace(
            "{service}",
            profile.top_service.name,
          )}
        </p>
      ) : null}
      {profile.top_staff ? (
        <p className="text-[11px] text-nq-muted">
          <span aria-hidden>❤️ </span>
          {labels.favoriteStaffPrefix.replace(
            "{name}",
            profile.top_staff.name,
          )}
        </p>
      ) : null}
      {profile.notes ? (
        <p
          className={cn(
            "text-[11px]",
            noteIsWarning ? "font-semibold text-nq-error" : "text-nq-muted",
          )}
        >
          <span className="font-semibold">{labels.notesLabel}: </span>
          {profile.notes}
        </p>
      ) : null}
    </div>
  );
}


function AvailabilityCard({
  state,
  recommended,
  isAutoMatch,
  labels,
  onResetToBestMatch,
}: {
  state: AvailabilityState;
  recommended: StaffAvailability | null;
  isAutoMatch: boolean;
  labels: WalkinAddFormProps["labels"];
  onResetToBestMatch: () => void;
}) {
  if (state.kind === "loading") {
    return (
      <p
        role="status"
        className="inline-flex items-center gap-1.5 text-xs text-nq-muted"
        data-testid="walkin-availability-loading"
      >
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-nq-primary/80"
        />
        {labels.availabilityChecking}
      </p>
    );
  }
  if (state.kind === "error" || !recommended) return null;

  const readyAtClock = recommended.estimatedReadyAt
    ? new Date(recommended.estimatedReadyAt).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  const isHeavy = recommended.overloaded;
  const isFree = recommended.isAvailableNow;

  const recHeading = isAutoMatch
    ? labels.bestMatchRecommendation
        .replace("{name}", recommended.staffName)
        .replace(
          "{wait}",
          isFree ? labels.readyNow : labels.waitMinutesShort(recommended.waitMinutes),
        )
    : recommended.staffName;

  return (
    <div
      role="status"
      data-testid="walkin-availability-card"
      data-walkin-availability-state={
        isFree ? "free" : isHeavy ? "heavy" : "busy"
      }
      className={cn(
        "space-y-1 rounded-md border bg-nq-surface px-2.5 py-2 text-xs text-nq-foreground",
        isFree
          ? "border-emerald-400/55 ring-1 ring-emerald-300/35"
          : isHeavy
            ? "border-amber-500/55 ring-1 ring-amber-400/35"
            : "border-nq-muted/35",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {isFree ? "✅" : isHeavy ? "⚠️" : "⏳"} {recHeading}
          </p>
          {!isAutoMatch ? (
            <p className="text-[11px] text-nq-muted">
              {isFree
                ? labels.readyNow
                : isHeavy
                  ? labels.heavyLoadDetail
                  : labels.waitMinutesShort(recommended.waitMinutes)}
            </p>
          ) : null}
          {!isFree && readyAtClock ? (
            <p className="text-[11px] text-nq-muted">
              {labels.readyAroundTime.replace("{time}", readyAtClock)}
            </p>
          ) : null}
          {recommended.queueAhead > 0 ? (
            <p className="text-[11px] text-nq-muted">
              {labels.queueAheadHint(recommended.queueAhead)}
            </p>
          ) : null}
          {recommended.confidenceLevel === "low" && !isHeavy ? (
            <p className="text-[11px] font-semibold text-amber-700">
              {labels.confidenceLow}
            </p>
          ) : null}
          {recommended.confidenceLevel === "medium" ? (
            <p className="text-[11px] text-nq-muted">
              {labels.confidenceMedium}
            </p>
          ) : null}
        </div>
        {!isAutoMatch && !isFree ? (
          <button
            type="button"
            onClick={onResetToBestMatch}
            className="min-h-11 shrink-0 touch-manipulation whitespace-nowrap rounded-md border border-nq-muted/35 bg-nq-bg px-3 py-2 text-xs font-semibold text-nq-foreground hover:bg-nq-surface focus:outline-none focus:ring-2 focus:ring-nq-primary/35"
            data-testid="walkin-availability-reset"
          >
            {labels.pickAnotherStaff}
          </button>
        ) : null}
      </div>
    </div>
  );
}
