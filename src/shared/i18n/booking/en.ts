/**
 * Public booking UI (`/[slug]`) copy: English only.
 * Do not import user locale or `useUserLanguage` here.
 */
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
  /** Public surface fallback when the salon hasn't replaced "Staff 1"-style placeholders yet. */
  staffPlaceholderName: "(Pending)",
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
  manageBookingCall: "Call to reschedule",
  doneCta: "Book another",
  submitError: "Could not complete booking. Please try again.",
  summaryShop: "Salon",
  summaryService: "Service",
  summaryStaff: "Staff",
  summaryTime: "Time",
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
      "Phone format invalid. Example: 555-123-4567",
    phoneRequired: "Enter your phone number.",
    nameRequired: "Please enter your name.",
    nameTooLong: "Name cannot exceed 100 characters.",
    invalidNameChars:
      "Name contains invalid characters.",
    serviceRequired: "Please select a service to continue.",
  },
  clientNameLabel: "Your name",
  clientPhoneLabel: "Phone number",
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
  upsellHeading: "You have extra time — add a service?",
  upsellNoThanks: "No thanks",
  upsellToggleHint: "Tap to include before you confirm.",
  /** Right column when `totalMinutes` from DB is 0 */
  serviceDurationFlexible: "Flexible",
  /** Minute suffix on service tiles, e.g. "45 min" */
  minuteSuffixShort: "min",
} as const;

export type BookingMessages = typeof bookingEn;
