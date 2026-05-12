/**
 * Public booking UI (`/[slug]`) copy: English only.
 * Do not import user locale or `useUserLanguage` here.
 */
import { PHONE_INPUT_PLACEHOLDER_NANP } from "@/shared/lib/phoneFormat";

export const bookingEn = {
  pageTitle: "Book this salon",
  pageSubtitle:
    "Choose service, staff, date, and time — then your details and review.",
  /** Desktop stepper labels */
  breadcrumbServices: "Services",
  breadcrumbStaff: "Staff",
  breadcrumbDate: "Date",
  breadcrumbTime: "Time",
  breadcrumbYourDetails: "Your details",
  breadcrumbConfirm: "Review",
  /** Left column (`lg:`) hero */
  salonHeroEyebrow: "Reserve with",
  salonHeroTagline:
    "Curated nail artistry in a calm, refined space — your visit begins here.",
  salonHeroAriaLabel: "Salon",
  stepServiceHeading: "Choose a service",
  stepStaffHeading: "Who would you like?",
  stepDateHeading: "Select a date",
  stepTimeHeading: "Choose a time",
  stepInfoHeading: "Your information",
  stepConfirmHeading: "Review & confirm",
  anyStaffOptionTitle: "Any available staff",
  anyStaffOptionSubtitle: "Any",
  anyStaffSummary: "Any available staff",
  dateClosedLabel: "Closed",
  dateClosedShort: "Closed",
  dateHolidayLabel: "Salon closed",
  dateHolidayShort: "Off",
  /** Calendar month navigation (e.g. "Previous month"). */
  calendarPrevMonthAria: "Previous month",
  calendarNextMonthAria: "Next month",
  /** Calendar legend below grid. */
  calendarLegendAvailable: "Slots available",
  calendarLegendClosed: "Closed",
  /** `{n}` = number of open slot buttons for that day. */
  scarcityFewSlots: "Only {n} open times left — this day is filling up.",
  slotLoading: "Loading times…",
  noSlotsAvailable: "No open slots that day. Try another date.",
  /** `{tz}` = short timezone abbreviation, e.g. "PDT", "GMT+7". Hidden if abbreviation unavailable. */
  slotsTimezoneLabel: "All times in {tz}",
  next: "Continue",
  back: "Back",
  confirmBooking: "Confirm booking",
  submitting: "Submitting…",
  successHeading: "You're all set!",
  /** Shown under the heading when a staff member is assigned, e.g. "with Jenny". */
  successStaffLine: "with {name}",
  successSeeYouSoonBefore: "See you soon at ",
  bookingReferenceLabel: "Booking reference",
  addToCalendar: "Add to calendar",
  /** Confirmation toast after the .ics file is generated. */
  addToCalendarDownloaded: "Calendar file ready — open it to add the event.",
  shareBooking: "Share",
  /** Native share sheet title (short). */
  shareBookingSheetTitle: "NailIQ booking",
  shareBookingCopied: "Booking details copied — paste into Messages or Zalo.",
  /** `{phone}` = the salon's public phone number, formatted via `formatPhone`. */
  manageBookingCall: "Need to reschedule? Call us: {phone}",
  doneCta: "Book another",
  submitError: "Could not complete booking. Please try again.",
  summaryShop: "Salon",
  summaryService: "Service",
  summaryStaff: "Staff",
  summaryTime: "Time",
  summaryDuration: "Duration",
  /** `{n}` = total minutes (main service + add-on). e.g. "75 min". */
  summaryDurationMinutes: "{n} min",
  /** Tag appended to the duration row when an add-on is included, e.g. "75 min (incl. add-on)". */
  summaryDurationIncludesAddon: "incl. add-on",
  summaryClientName: "Your name",
  summaryClientPhone: "Phone",
  summaryClientNotes: "Notes",
  summaryAddOn: "Add-on",
  summaryServicePrice: "Service price",
  summaryAddonPrice: "Add-on price",
  summaryTotal: "Total",
  /** Structured booking error copy for confirm step / retries. Public booking stays English-only. */
  bookingErrors: {
    slotJustTaken:
      "This slot was just booked. Please pick another time.",
    invalidPhone:
      "Phone number invalid. Examples: +1 (604) 555-1234 or +84 90 123 4567",
    phoneRequired: "Enter your phone number.",
    nameRequired: "Please enter your name.",
    nameTooShort: "Name must be at least 2 characters.",
    nameTooLong: "Name cannot exceed 100 characters.",
    invalidNameChars:
      "Name contains invalid characters.",
    invalidEmail:
      "Email format invalid. Example: jane@email.com",
    serviceRequired: "Please select a service to continue.",
  },
  clientNameLabel: "Your name",
  clientPhoneLabel: "Phone number",
  /** Placeholder for contact step — NANP Canadian example; guests may enter any valid E.164. */
  clientPhonePlaceholder: PHONE_INPUT_PLACEHOLDER_NANP,
  clientEmailLabel: "Email (optional)",
  clientEmailHint: "Receive booking confirmation by email.",
  clientNotesLabel: "Special notes",
  clientNotesOptionalHint: "Optional — allergies, design ideas, parking, etc.",
  waitlistNotifyCta: "Notify me if a slot opens",
  waitlistSubmitting: "Saving…",
  waitlistJoined:
    "You're on the list. We'll text you if something opens.",
  waitlistError: "Couldn't save your request. Try again.",
  /** Legacy banner copy when both fields are empty on Continue (prefer field-level bookingErrors.*). */
  contactRequiredError: "Please enter your name and phone.",
  pastTimeError:
    "This time has already passed. Please select a future time.",
  outsideHoursError: "That time is outside salon hours. Please pick another slot.",
  salonClosedError: "The salon is closed that day. Please pick another date.",
  salonNotLiveHeading: "Booking is paused",
  salonNotLiveBody:
    "{shop} is finishing setup and isn’t taking online bookings yet. Please check back soon.",
  /** `{n}` = staff free-gap minutes after the chosen service. */
  upsellHeading: "Add another service? You have {n} extra minutes available.",
  upsellNoThanks: "No thanks",
  upsellToggleHint: "Pick one before you confirm to bundle it with your booking.",
  /** Right column when `totalMinutes` from DB is 0 */
  serviceDurationFlexible: "Flexible",
  /** Minute suffix on service tiles, e.g. "45 min" */
  minuteSuffixShort: "min",
  /** Small badge rendered on `services.is_popular === true` tiles. */
  popularBadge: "Popular",
  /** Small badge rendered on `services.is_featured === true` tiles. */
  featuredBadge: "Featured",
  /** Aria label on each category accordion header — "Toggle {category} services". */
  categoryToggleAria: "Toggle {category} services",
  /** Label on the action button that appears inside an expanded
   *  service tile. Tap commits the service to the booking flow. */
  selectThisService: "Select this service",
  /** Aria label on the per-tile expand/collapse header button. */
  serviceTileToggleAria: "Toggle {service} details",
  /** P1.4 — aria label on the small chevron that toggles the
   *  description preview without committing the service. */
  serviceTileDescriptionAria: "Show description for {service}",
  /** Group booking (Phase 1). 2–4 friends/family book together; each
   * member becomes its own `bookings` row bound by a shared
   * `group_id`. Out-of-scope strings (split, merge, queue) are
   * intentionally NOT added — those flows don't exist yet. */
  groupBooking: {
    entryTitle: "How would you like to book?",
    individual: "Individual",
    group: "Group 👥",
    sizeHeading: "How many people?",
    personLabel: "Person {n}",
    primaryContactHeading: "Primary contact",
    primaryContactHint:
      "We'll send the confirmation to this phone. Each person can add their own phone below if they want their own reminder.",
    /** QA P0.G3 — was "Review group booking" which read as a final
     * review step. This screen is the data-entry step. */
    reviewHeading: "Booking details per person",
    confirmGroup: "Confirm group booking",
    submittingGroup: "Booking your group…",
    successHeading: "Group booking confirmed! 🎉",
    successSubtitle: "Reference #{id}",
    conflictMember: "Conflict for Person {n} — pick a different time or staff.",
    conflictBanner:
      "{n} of your slots are no longer available. Adjust those people and try again.",
    /** P1.6 — distinguish in-group same-staff collision vs external
     * race (someone else just took the slot). `{n}` = 1-indexed
     * member number for cross-member. */
    conflictCrossMember:
      "Two people can't pick the same staff. Please choose a different staff for Person {n}.",
    conflictExternal:
      "This time was just booked by someone else. Please pick a different time.",
    /** P1.2 — past-date guard surfaced after server-side check. */
    pastDate:
      "Can't book in the past. Please pick a different date.",
    /** P1.1 — step-1 phone validation surfaces this when the user
     * clicks Next with an empty phone field. */
    phoneRequired: "Please enter a phone number.",
    duplicateSubmission:
      "Looks like this group was already booked. Refresh the page to see the confirmation.",
    salonClosedDay:
      "The salon is closed on one of the days you picked. Please choose a different date.",
    salonPaused: "This salon isn't accepting bookings right now.",
    invalidGroupSize: "Group size must be between 2 and 8 people.",
    serverError: "Couldn't book the group. Please try again.",
    addPerson: "Add person",
    removePerson: "Remove",
    /** P1.G1 — sticky contact-summary row. */
    editContact: "Edit",
    /** P0.G2 — shared schedule section. */
    sharedScheduleHeading: "Group date & time",
    sharedScheduleHint:
      "The whole group comes in at the same time. Each person picks their own service and staff below.",
    sharedScheduleRequired:
      "Please pick a date and time for the group.",
    /** Inline error under the staff dropdown for member-level
     * required + duplicate-staff cases (P0.G1 + P1.G7). */
    staffRequired: "Pick a staff member.",
    duplicateStaff:
      "This staff is already chosen for another person — pick a different staff.",
    /** P1.G8 — sticky totals footer. */
    totalLabel: "Total",
    peopleSuffix: "people",
    /** QA round-2 — staff-aware capacity hint under the size picker.
     * `{n}` = `maxGroupSize` (min of active-staff-count and hard cap). */
    maxSizeHint: "Up to {n} people (limited by available staff)",
    /** Live capacity probe on the shared schedule card. `loading`
     * fires while debounced fetch is in flight; `ok` is the steady
     * state; `insufficient` blocks submit. */
    availabilityChecking: "Checking how many staff are free…",
    availabilityOk: "{free} of {total} staff free at this time.",
    insufficientCapacity:
      "Only {n} staff free at this time. Pick a different time or reduce group size.",
    /** Receptionist surface: the group-icon tooltip + drawer chip. */
    groupIconLabel: "Part of a group booking",
    groupContextHeading: "Group members",
    cancelEntireGroup: "Cancel entire group",
    cancelEntireGroupConfirm:
      "Cancel every booking in this group? This affects {n} people.",
    /** ─── AI Arrival-First redesign (PR: feat/group-booking-ai-arrival) ───
     * 5-step flow: size → per-member service/staff → date & arrival
     * window → AI-generated 3-option arrangement → confirm. New keys
     * below; legacy keys above kept for receptionist-side reuse. */
    /** Step 3 — arrival-window heading. */
    arrivalQuestion: "When would you like to arrive?",
    arrivalMorning: "Morning · 9 AM – 12 PM",
    arrivalAfternoon: "Afternoon · 12 PM – 5 PM",
    arrivalEvening: "Evening · 5 PM – close",
    arrivalSpecific: "Specific time",
    /** Step 4 — three smart-schedule option cards. */
    schedulingBest: "Best — everyone within 15 min",
    schedulingAlt: "Alternative — within 30 min",
    schedulingEarly: "Earliest available",
    /** Recommended badge on the BEST card. */
    schedulingRecommended: "Recommended",
    /** Per-card "Finishes at {time}" footer line. */
    schedulingFinish: "Finishes at {time}",
    /** Empty-state copy when the scheduler returns zero arrangements. */
    schedulingNoSlots:
      "No slots available in that window. Try a different time or date.",
    schedulingTryDate: "Try another date",
    schedulingClosed:
      "Salon is closed on this date. Please pick another date.",
    /** Stepper labels — five top-level steps. */
    groupStep1: "Size",
    groupStep2: "Services",
    groupStep3: "Date & Time",
    groupStep4: "Arrangement",
    groupStep5: "Confirm",
    /** Step 5 success heading after submit. */
    groupSuccess: "Group booking confirmed!",
    groupRef: "Booking reference",
    /** Sticky-footer total label. */
    groupTotal: "Total",
    /** Step 2 cross-member soft-warning (non-blocking) shown when two
     * members pick the same staff. Submission only blocks if the
     * scheduler can't resolve any non-overlapping arrangement. */
    staffConflictNote:
      "Two people have selected the same staff. The scheduler will try to find a non-overlapping time.",
    /** P1 #18–#20 (QA re-sweep 2026-05-12) — granular submit-error
     *  copy. Each key matches a `submitGroupBooking` reason; UI
     *  substitutes `{n}` with the 1-indexed member number when the
     *  server returns one. The catch-all generic stays as
     *  `groupBooking.serverError` for truly unknown cases. */
    invalidNameForMember:
      "Person {n}'s name is missing or contains invalid characters.",
    invalidPhoneForMember:
      "Person {n}'s phone number isn't valid. Example: +1 (604) 555-1234 or +84 90 123 4567.",
    invalidEmailForMember:
      "Person {n}'s email format isn't valid. Example: jane@email.com.",
    invalidTimeForMember:
      "Person {n}'s time is invalid. Please pick again on the previous step.",
    invalidDateForMember:
      "Person {n}'s date is invalid. Please pick again on the previous step.",
    /** Same six errors but for client-side step 5 contact validation,
     *  before we even hit the server. Phone is the primary contact
     *  for the whole group so there's no member number. */
    contactInvalidPhone:
      "The phone number isn't valid. Example: +1 (604) 555-1234 or +84 90 123 4567.",
    contactInvalidEmail:
      "The email format isn't valid. Example: jane@email.com.",
    /** QA bug (2026-05-12, GB-3) — staged loading copy for step 4
     *  while `loadGroupSmartSchedule` is in flight. The scheduler
     *  can do up to (90 / SLOT_STEP_MIN ≈ 360) anchor probes plus
     *  per-anchor staff overlap checks, so on a cold cache + heavy
     *  salon day it can run 5–15s. Show a friendly progress line,
     *  bump to "still working" past 10s so the user knows we're
     *  alive, and offer a back-out at 20s. */
    schedulingSearching: "✨ Finding the best arrangements...",
    schedulingStillWorking: "Still working, please wait...",
    schedulingTimeout:
      "Could not find arrangements. Try another date.",
    /** Task #04-A FIX 03 — stale arrangement banner on step 5.
     *  The arrangement carries server-side availability snapshots
     *  that age out — by 3 min another customer may have grabbed
     *  one of the slots. Banner lets the user choose to confirm
     *  now (acceptable race) or refresh the schedule. */
    arrangementStale: "This arrangement is 3+ min old.",
    confirmAnyway: "Confirm anyway",
    refreshSchedule: "Refresh schedule",
    /** FIX 14 — idle reminder on step 5. The booking isn't
     *  cancelled, just nudged. */
    sessionExpiringSoon:
      "Session expiring soon. Please confirm to lock in your slots.",
  },
};

// P0.1 — keep the literal-type info for callers that want
// autocomplete but drop the `as const` literal constraint so the VI
// bundle can supply Vietnamese strings without each one having to
// be the same literal as the English. Mapped type preserves nested
// bookingErrors shape.
type WidenLiterals<T> = T extends string
  ? string
  : T extends object
    ? { [K in keyof T]: WidenLiterals<T[K]> }
    : T;
export type BookingMessages = WidenLiterals<typeof bookingEn>;
