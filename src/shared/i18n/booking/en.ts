/**
 * Public booking UI (`/[shop]`) copy: English only.
 * Do not import user locale or `useUserLanguage` here.
 */
export const bookingEn = {
  pageTitle: "Book this salon",
  pageSubtitle: "You’re on the public booking experience.",
  placeCta: "Choose a time",
  note: "Language for guests is English only. Salon owners can switch app language in the owner experience.",
} as const;

export type BookingMessages = typeof bookingEn;
