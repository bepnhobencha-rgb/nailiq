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
  breadcrumbPhone: "Phone",
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
  giftCardPageLink: "Buy a Gift Card",
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
  summaryDiscount: "Discount",
  summaryTotal: "Total",
  voucherLabel: "Promo code",
  voucherPlaceholder: "Enter code",
  voucherApply: "Apply",
  voucherRemove: "Remove",
  /** `{code}` replaced at runtime. */
  voucherApplied: "Code {code} applied!",
  voucherErrors: {
    invalid: "This code is not valid.",
    exhausted: "This code has already been used.",
    notYours: "This code is not linked to your phone number.",
    belowMinSpend: "Minimum spend of {amount} required.",
    generic: "Could not apply code. Please try again.",
  },
  /** Optional reference image upload on the Info step. */
  refImageLabel: "Inspiration image (optional)",
  refImageHelp: "Upload a reference photo (optional)",
  refImageUploading: "Uploading…",
  refImageDone: "Image uploaded",
  refImageRemove: "Remove",
  /** Structured booking error copy for confirm step / retries. Public booking stays English-only. */
  bookingErrors: {
    slotJustTaken:
      "This slot was just booked. Please pick another time.",
    wixSlotTaken:
      "Sorry, this time slot was just booked by someone else. Please choose a different time.",
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
    monthlyLimitReached:
      "This salon has reached its monthly online booking limit. Please call the salon to book.",
    otpRequired: "Phone verification required. Please verify your number.",
    otpInvalidCode: "Incorrect code. Please try again.",
    otpExpired: "Code expired or too many attempts. Send a new code.",
    otpSendFailed: "Couldn't send SMS. Please try again.",
  },
  /** OTP verification step (only shown when salon enables phone OTP). */
  otpStepHeading: "Verify your phone",
  otpStepSubheading: "We sent a code to",
  otpCodeLabel: "6-digit code",
  otpCodePlaceholder: "123456",
  otpSendCode: "Send code",
  otpResend: "Resend",
  otpResendIn: "Resend in {s}s",
  otpVerify: "Verify",
  otpVerifying: "Verifying…",
  otpSending: "Sending…",
  otpVerified: "Phone verified ✓",
  otpSkip: "Skip",
  otpOptionalHint: "Verifying your phone helps reduce no-shows (optional)",
  verifyingBooking: "Checking booking…",
  clientNameLabel: "Your name",
  clientPhoneLabel: "Phone number",
  /** Hint shown below the phone label — lets returning customers know their info will auto-fill. */
  clientPhoneHint: "✨ Returning customer? Your info will load automatically.",
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
  /** Shown when a slot was offered but is now within the booking lead window
   *  by submit time (e.g. the 9:00 slot at 8:56 with a 5-min lead). */
  slotTooSoonError:
    "That time is too close to now to book online — please pick a later slot.",
  outsideHoursError: "That time is outside salon hours. Please pick another slot.",
  salonClosedError: "The salon is closed that day. Please pick another date.",
  salonNotLiveHeading: "Booking is paused",
  salonNotLiveBody:
    "{shop} is finishing setup and isn’t taking online bookings yet. Please check back soon.",
  /** `{n}` = staff free-gap minutes after the chosen service. */
  upsellHeading: "Your tech is free for {n} more minutes — want to add a service?",
  upsellNoThanks: "No thanks",
  upsellToggleHint: "Pick one before you confirm to bundle it with your booking.",
  /** Right column when `totalMinutes` from DB is 0 */
  serviceDurationFlexible: "Flexible",
  /** Minute suffix on service tiles, e.g. "45 min" */
  minuteSuffixShort: "min",
  /** Smart Gap-Free Scheduling pill (Phase 5): slot perfectly fills a gap. */
  slotBestFit: "Best fit",
  /** Smart Gap-Free Scheduling pill (Phase 5): slot is a strong back-to-back match. */
  slotRecommended: "Recommended",
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
    /** Default placeholder name for group members before the invited
     *  guest claims their slot via Party Link. Format: "{label} {n}" */
    groupGuestLabel: "Guest",
    /** Helper text shown below the member form in step 2. */
    partyLinkMemberHint:
      "Guests can update their own details later through the Party Link.",
    primaryContactHeading: "Primary contact",
    primaryContactHint:
      "We'll send the confirmation to this phone. Each person can add their own phone below if they want their own reminder.",
    /** QA P0.G3 — was "Review group booking" which read as a final
     * review step. This screen is the data-entry step. */
    reviewHeading: "Booking details per person",
    /** Step-2 "same service for everyone" quick-fill card. Picking a
     *  service here applies it to all members at once; each person can
     *  still override below. */
    sameServiceHeading: "Same service for everyone?",
    sameServiceHint: "Pick once for the whole group — you can change anyone below.",
    sameServicePlaceholder: "Choose a service for the group",
    sameServiceApplied: "Applied to all {n} guests",
    sameServiceMixed: "Each guest has their own service",
    memberCustomBadge: "Changed",
    /** Step-2 couple/group "sit together" toggle + reception badge. */
    seatTogetherLabel: "Seat us next to each other",
    seatTogetherHint:
      "We'll arrange adjacent beds with a shared curtain when possible.",
    seatTogetherBadge: "Seat together",
    seatTogetherConfirm: "We'll seat your group next to each other 💕",
    /** Step-5 organizer recognition (returning-customer greeting). */
    organizerGreeting: "Welcome back, {name}!",
    /** New-customer greeting at the gate (phone not recognized). */
    entryNewGreeting: "Hi {name}! 👋",
    organizerVip: "VIP",
    organizerReturning: "Returning guest · {n} visits",
    organizerUsual: "Usual: {service}",
    organizerChecking: "Checking…",
    organizerIsGuestLabel: "I'm also getting a service with the group",
    /** Success-screen QR / share-to-join copy. */
    partyLinkScan: "Each guest scans to confirm their own slot and add their number.",
    partyLinkShareBtn: "Share",
    /** Per-guest add-on section label in step 2. */
    addOnsLabel: "Add-ons (optional)",
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
    /** Step 3 — sync-mode toggle (arrive-together vs finish-together). */
    syncModeQuestion: "How should your group plan together?",
    syncStart: "🚶 Arrive together",
    syncStartHint: "Everyone starts around the same time",
    syncFinish: "🏁 Finish together",
    syncFinishHint: "Everyone is done at the same time",
    /** Time input label that appears when sync_finish is chosen. */
    finishTimeLabel: "Finish by (target time)",
    finishTimeHint: "The whole group will be done by this time",
    /** Validation error when user proceeds without setting a finish time. */
    finishTimeRequired: "Please set a target finish time.",
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
    /** Step 4 cards — sync_finish mode labels (replace the ≤15/≤30 min
     *  start-spread copy which is meaningless when everyone ENDS together). */
    schedulingFinishBest: "On time ✨",
    schedulingFinishAlt: "Alternative time 🔄",
    schedulingFinishEarly: "Earliest possible ⚡",
    /** Recommended badge on the BEST card. */
    schedulingRecommended: "Recommended",
    /** Phase 6.1 — wave booking (large group split across time). */
    waveSplitLabel: "Split into {count} waves",
    waveLineLabel: "Wave {n}: {count} guests at {time}",
    waveFinishUnsupported:
      "Finish together is not available for this large group. Try Arrive together or another time.",
    /** Per-card "Finishes at {time}" footer line. */
    schedulingFinish: "Finishes at {time}",
    /** Empty-state copy when the scheduler returns zero arrangements. */
    schedulingNoSlots:
      "No slots available in that window. Try a different time or date.",
    schedulingTryDate: "Try another date",
    /** Task #04-D FIX 06 — capacity-specific copy used when the
     *  scheduler returns `no_slots`. Distinct from the more generic
     *  `schedulingNoSlots` (kept as a fallback) because most real
     *  "no_slots" cases are "all staff fully booked on this day",
     *  not "no opening hours match". */
    allStaffBooked:
      "All staff fully booked this day. Try another date or reduce group size.",
    /** Quick-pick button label rendered on the empty state. The
     *  next two quick-picks use the salon-local weekday/date
     *  rendered via `formatInSalonTz` rather than a fixed key. */
    tryTomorrow: "Tomorrow",
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
    /** Task #04-B — defensive copy for `loadGroupSmartSchedule`'s
     *  `timezone_not_set` reason. Salon DB column is NOT NULL after
     *  migration 20260512600000, so the user should only see this
     *  if the row was wiped or the migration reverted. */
    timezoneNotSet:
      "This salon hasn't set its timezone yet. Please contact the salon to confirm booking times.",
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
    /** Task #04-C FIX 01 — pre-submit availability probe banner
     *  on step 5 while the auto-rescheduler is running. */
    slotTakenRefinding:
      "A slot was just taken. Finding new options...",
    /** FIX 10 — copy for the slot_conflict path after submit
     *  (DB-level race). Distinct from `conflictExternal` because
     *  this specifically blames another *group* (the most common
     *  collision pattern at the busy times when groups book). */
    concurrentGroupTaken:
      "Another group just booked one of these slots. Loading fresh options...",
    /** FIX 12 — staff was deleted/inactivated between arrangement
     *  selection and submit. Triggers an auto-rerun of the
     *  scheduler. */
    staffUnavailable: "Staff is no longer available. Finding a replacement...",
    /** FIX 13 — service was soft-deleted between step 2 and submit.
     *  Triggers a bounce back to step 2 to re-pick. */
    serviceUnavailable:
      "Service is no longer offered. Please choose another.",
    /** Task #05 — smart-alternatives panel on step 4 when the
     *  full group can't fit on the requested date. Header carries
     *  the panel's intent; per-card copy below interpolates the
     *  numeric/temporal values the scheduler returned. */
    groupAlternativesTitle: "We found options for your group!",
    /** `{n}` = main group size that DID fit at `{time}`. Used as
     *  the header sub-line when the split sub-query returned a
     *  result. */
    groupPartialCapacity: "Only {n} spots available at {time}.",
    /** Split-option card title. `{n}` = main size, `{time}` =
     *  main wall-time, `{name}` = late member name, `{lateTime}` =
     *  late wall-time. */
    groupSplitOption: "{n} people at {time}, {name} at {lateTime}",
    /** Split-option card subtitle — "Everyone done by HH:MM". */
    groupSplitDone: "Everyone done by {time}",
    /** Next-available-date card title. `{label}` = "Tomorrow" or
     *  localized weekday+day, `{n}` = full group size, `{time}` =
     *  earliest start wall-time on that day. */
    groupNextDate: "{label} — {n} people together at {time}",
    /** Earlier-today card title. `{n}` = full group size,
     *  `{time}` = earliest start wall-time in the alternate
     *  window (morning ↔ afternoon flip). */
    groupEarlierToday: "Earlier today — {n} people at {time}",
    /** Per-card "Choose this option →" CTA label. */
    groupChooseOption: "Choose this option →",
    /** "Try a different date" — last-resort back-out shown
     *  alongside the cards. Distinct from the legacy
     *  `schedulingTryDate` so PMs can tune it without affecting
     *  the older empty-state surfaces that still reference the
     *  shorter copy. */
    groupTryDifferentDate: "Try a different date",
    /** Label used by the next-date card when the suggested date
     *  is salon-local tomorrow. Other days use the formatted
     *  weekday + day. */
    groupTomorrow: "Tomorrow",
    /** Truly-empty empty-state copy used when reason is
     *  `no_slots` AND every sub-query returned null/timed out. */
    groupNoAlternatives:
      "No available slots found. Please try another date.",
    /** Phase 2 — Party Link share box on the success panel. */
    partyLinkShare: "Share with your group",
    partyLinkHint: "Send this link so everyone can confirm their slot.",
    partyLinkCopy: "Copy",
    partyLinkCopied: "Copied!",
    partyLinkUnavailable:
      "Party Link could not be generated. Your booking is confirmed — share it manually.",
  },

  /** Strings used on the public /party/[token] page. */
  partyPage: {
    /** Page header */
    invited: "You're invited!",
    groupBookingAt: "Group booking at",
    /** Sync mode labels */
    modeStart: "Everyone starts together",
    modeFinish: "Everyone finishes together",
    /** Expired banner */
    expiredBanner: "This party link has expired. Please ask the organiser to share a new one.",
    /** Slot card */
    claimed: "Confirmed",
    claimBtn: "This is me",
    cancelBtn: "Cancel",
    expiredLabel: "Expired",
    /** Phase 6 — wave section heading on large split-group party links. */
    waveLabel: "Wave",
    /** UI polish — invitation subtext, wave summary, claim-form intro. */
    invitedSubtext: "Confirm your spot in 30 seconds.",
    wavesBadge: "{count} waves",
    waveExplain: "Your group is split into waves so the salon can serve everyone smoothly.",
    waveGuestCount: "{count} guests",
    guestWord: "Guest",
    claimFormTitle: "Confirm this spot is yours",
    claimFormSubtext: "Enter your name and phone so the salon can send reminders.",
    /** Shown when the guest's phone matches a returning customer. */
    recognizedGreeting: "Welcome back, {name}! 👋",
    /** Claim form */
    formNameLabel: "Your name",
    formNamePlaceholder: "e.g. Sarah",
    formPhoneLabel: "Phone number",
    formPhonePlaceholder: "+1 604 555 0123",
    formPhoneHint: "Include your country code (e.g. +1 for Canada/US, +84 for Vietnam).",
    formReminderLabel: "Send me a reminder before my appointment",
    formSubmit: "Confirm my slot",
    formSubmitting: "Claiming…",
    /** Error messages */
    errNameRequired: "Please enter your name.",
    errPhoneRequired: "Please enter your phone number.",
    errAlreadyClaimed: "This slot was just claimed by someone else. Refresh to see who got it.",
    errExpired: "This party link has expired. Ask the organiser for a new one.",
    errNotFound: "This party link no longer exists.",
    errInvalidInput: "Please check your name and phone number (include country code, e.g. +1 604…).",
    errGeneric: "Something went wrong. Please try again.",
    /** Not-found / expired full-page states */
    notFoundTitle: "Link not found",
    notFoundBody: "This party link doesn't exist or may have already expired. Ask the organiser to resend it.",
    expiredTitle: "Link expired",
    expiredBody: "This party link has passed its 24-hour window. Ask the organiser to share a new booking.",
    /** Footer */
    poweredBy: "Powered by",

    /** Phase 6.2 — Party Guest Passport */
    claimBtnSpot: "This is my spot",
    phonePrivacyNote: "🔒 Your phone number is only used for this appointment and is not shown to other guests.",
    formPhoneLabelReminder: "Reminder phone number",
    personalPassTitle: "Your Personal Pass",
    arrivalNote: "Please arrive 5 minutes early.",
    waveNoteTemplate: "You are in {waveLabel}. You don't need to arrive with the other wave unless you want to join your group.",
    addToCalendarBtn: "Add to Calendar",
    groupProgressLabel: "{confirmed} of {total} confirmed",
    groupProgressPending: "{pending} still pending",

    /** Part C — "Edit my details" section shown after claiming. */
    editMyDetails: "Edit my details",
    editDetailsHeading: "Update your details",
    editDetailsSave: "Save changes",
    editDetailsSaving: "Saving…",
    editDetailsSuccess: "Details updated!",
    editDetailsCancel: "Cancel",
    editDetailsErrName: "Please enter your name.",
    editDetailsErrPhone: "Please check your phone number (include country code).",
    editDetailsErrGeneric: "Couldn't update details. Please try again.",

    /** Part E — change request section shown after claiming. */
    needToChange: "Need to change something?",
    changeRequestHint: "Submit a request and the salon will review it.",
    changeServiceBtn: "Request service change",
    changeStaffBtn: "Request preferred staff",
    addNoteBtn: "Message salon",
    changeRequestNotePlaceholder: "e.g. I'd prefer a different option or have a specific request…",
    changeRequestSubmit: "Submit request",
    changeRequestSubmitting: "Submitting…",
    changeRequestSuccess: "Your request has been sent to the salon.",
    changeRequestErrGeneric: "Couldn't submit request. Please try again.",
    changeRequestClose: "Close",
  },
  chat: {
    trigger: "Ask AI",
    heading: "AI Assistant",
    placeholder: "Ask about services, hours, pricing…",
    send: "Send",
    typingIndicator: "Thinking…",
    errorFallback: "Sorry, I couldn't connect. Please try again.",
    disclaimer: "AI assistant — for bookings, use the form above.",
  },
  /** Phone step — the new hero step 1 of the booking flow. */
  phoneStepHeading: "Book your appointment",
  phoneStepSubheading: "Enter your phone number to get started",
  phoneStepNewCustomerHint: "First time? Still enter your number to receive SMS reminders.",
  rebookHeading: "Rebook your usual?",
  rebookNow: "Rebook now ⚡",
  rebookChange: "Change",
  /** `{name}` replaced at runtime — e.g. "with Jenny" */
  rebookWith: "with {name}",
  rebookAnyStaff: "Any available staff",
  /** Returning-customer recognition strings (Info step phone lookup). */
  returningCustomer: {
    welcomeBack: "Welcome back!",
    /** `{n}` = visit count, e.g. "Visit 4 at this salon" */
    visitCount: "Visit {n} at this salon",
    vipBadge: "VIP",
    preferredStaffHeading: "Your usual tech",
    /** `{name}` = staff first name */
    preferredStaffPrompt: "Book with {name} again?",
    /** `{name}` = staff first name */
    acceptPreferredStaff: "Yes, book with {name}",
    dismissPreferredStaff: "No thanks",
    /** `{name}` = staff first name — shown when user already selected their preferred tech */
    alreadyWithPreferred: "Booking with {name} ✓",
  },
  voice: {
    tapToSpeak: "Speak to book",
    listening: "Listening…",
    aiSpeaking: "Lily speaking…",
    speakNow: "Tell us what you'd like — e.g. 'Manicure with Jenny next Friday'",
    done: "Done",
    ended: "Call ended",
    connecting: "Connecting…",
    micRequest: "Requesting microphone…",
    settingUp: "Setting up…",
    processing: "Understanding your request…",
    matched: "✓ Got it",
    noMatch: "Couldn't understand — please try again or book manually.",
    parseError: "Something went wrong. Please try again.",
    micPermissionDenied: "Microphone access denied. Please allow it in your browser settings.",
    micError: "Couldn't start recording. Please try again.",
    notSupported: "Voice input isn't supported in this browser.",
    voiceNotEnabled: "Voice booking is not enabled for this salon.",
    sessionLimitReached: "Voice session limit reached for this month.",
    openaiRateLimit: "Lily is currently busy — please try again in a moment or book manually below.",
    endCall: "End Call",
    cancel: "Cancel",
    close: "Close",
    tryAgain: "Try Again",
    youLabel: "You",
    aiLabel: "Lily",
    /** iPhone / Safari fallback: keyboard dictation */
    textInputHint: "Tap 🎤 on your keyboard to dictate, or just type:",
    textInputPlaceholder: "e.g. Manicure with Jenny next Friday at 2pm",
    textSubmit: "Search",
    chatGreeting: "Hello! Thank you for calling. How can I help you today?",
    chatSpeaking: "Speaking…",
    chatCancel: "Cancel",
    slotNotFound: "{time} isn't available — please pick another time below.",
    bookingConfirmed: "Booking confirmed!",
    bookingRescheduled: "Booking rescheduled!",
    bookingCancelled: "Booking cancelled",
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
