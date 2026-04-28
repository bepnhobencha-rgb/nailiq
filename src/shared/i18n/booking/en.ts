/**
 * Public booking UI (`/[shop]`) copy: English only.
 * Do not import user locale or `useUserLanguage` here.
 */
export const bookingEn = {
  pageTitle: "Book this salon",
  pageSubtitle: "Select a service, pick a time, and confirm your booking.",
  stepServiceHeading: "1. Choose a service",
  stepTimeHeading: "2. Choose a time",
  stepConfirmHeading: "3. Confirm booking",
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
} as const;

export type BookingMessages = typeof bookingEn;
