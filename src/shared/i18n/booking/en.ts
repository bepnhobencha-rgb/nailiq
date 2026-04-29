/**
 * Public booking UI (`/[shop]`) copy: English only.
 * Do not import user locale or `useUserLanguage` here.
 */
export const bookingEn = {
  pageTitle: "Book this salon",
  pageSubtitle:
    "Choose a service, then staff, date, and time — confirm when ready.",
  /** Desktop stepper labels */
  breadcrumbServices: "Services",
  breadcrumbStaff: "Staff",
  breadcrumbDate: "Date",
  breadcrumbTime: "Time",
  breadcrumbConfirm: "Confirm",
  /** Left column (`lg:`) hero */
  salonHeroEyebrow: "Reserve with",
  salonHeroTagline:
    "Curated nail artistry in a calm, refined space — your visit begins here.",
  salonHeroAriaLabel: "Salon",
  stepServiceHeading: "Choose a service",
  stepStaffHeading: "Who would you like?",
  stepDateHeading: "Select a date",
  stepTimeHeading: "Choose a time",
  stepConfirmHeading: "Confirm booking",
  anyStaffOptionTitle: "Any available staff",
  anyStaffOptionSubtitle: "Any",
  anyStaffSummary: "Any available staff",
  dateClosedLabel: "Closed",
  dateClosedShort: "Closed",
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
  addToCalendar: "Add to Calendar",
  doneCta: "Done",
  submitError: "Could not complete booking. Please try again.",
  summaryShop: "Salon",
  summaryService: "Service",
  summaryStaff: "Staff",
  summaryTime: "Time",
  clientNameLabel: "Your name",
  clientPhoneLabel: "Phone number",
  slotTakenError:
    "That time was just booked. Please pick another slot and try again.",
  pastTimeError:
    "This time has already passed. Please select a future time.",
  /** Right column when `totalMinutes` from DB is 0 */
  serviceDurationFlexible: "Flexible",
  /** Minute suffix on service tiles, e.g. "45 min" */
  minuteSuffixShort: "min",
} as const;

export type BookingMessages = typeof bookingEn;
