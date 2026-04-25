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
  successMessage: "Your booking is confirmed.",
  submitError: "Could not complete booking. Please try again.",
  summaryShop: "Salon",
  summaryService: "Service",
  summaryTime: "Time",
} as const;

export type BookingMessages = typeof bookingEn;
