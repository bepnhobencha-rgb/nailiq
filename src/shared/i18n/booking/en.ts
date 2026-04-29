/**
 * Public booking UI (`/[shop]`) copy: English only.
 * Do not import user locale or `useUserLanguage` here.
 */
export const bookingEn = {
  pageTitle: "Book this salon",
  pageSubtitle: "Select a service, pick a time, and confirm your booking.",
  /** Desktop stepper labels (Services → Time → Confirm) */
  breadcrumbServices: "Services",
  breadcrumbTime: "Time",
  breadcrumbConfirm: "Confirm",
  /** Left column (`lg:`) hero */
  salonHeroEyebrow: "Reserve with",
  salonHeroTagline:
    "Curated nail artistry in a calm, refined space — your visit begins here.",
  salonHeroAriaLabel: "Salon",
  stepServiceHeading: "Choose a service",
  stepTimeHeading: "Choose a time",
  stepConfirmHeading: "Confirm booking",
  next: "Continue",
  back: "Back",
  confirmBooking: "Confirm booking",
  submitting: "Submitting…",
  successHeading: "You're all set!",
  successSeeYouSoonBefore: "See you soon at ",
  bookingReferenceLabel: "Booking reference",
  addToCalendar: "Add to Calendar",
  doneCta: "Done",
  submitError: "Could not complete booking. Please try again.",
  summaryShop: "Salon",
  summaryService: "Service",
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
