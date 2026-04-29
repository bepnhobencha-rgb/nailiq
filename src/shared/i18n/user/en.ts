/**
 * User-facing copy (home shell + owner dashboard): English (default).
 */
export type UserMessages = {
  brandName: string;
  /** sr-only and lightweight metadata-minded blurb */
  seoIntro: string;
  home: {
    headline: string;
    subline: string;
    ctaRegister: string;
    footerNote: string;
    navOwnerLogin: string;
    navOwnerLoginShort: string;
    alreadySalonPrefix: string;
    signInLink: string;
  };
  register: {
    returningOwnerHint: string;
    /** Shown after “Send code” when this phone is already tied to a salon (before verify). */
    welcomeBackAfterSend: string;
    /** Enter-code screen when continuing as returning owner */
    welcomeBackVerifySubtext: string;
    /** Demo path (new signup) — short line beside DEMO MODE badge */
    newDemoOtpBadgeNote: string;
  };
  salonDashboard: {
    title: string;
    slugLabel: string;
    bookingPageUrl: string;
    copyLink: string;
    copied: string;
    viewBookingPage: string;
    todaySummary: string;
    totalToday: string;
    pending: string;
    confirmed: string;
    completed: string;
    estRevenue: string;
    todayAppointments: string;
    upcomingConfirmed: string;
    noBookingsToday: string;
    noUpcoming: string;
    advanceStatus: string;
    client: string;
    service: string;
    salonStaffLabel: string;
    phone: string;
    /** Guest notes from the booking form (owner-visible). */
    clientNotes: string;
    loading: string;
    /** Manual dashboard refresh */
    refresh: string;
    /** Dashboard → /settings hub (gear button) */
    navSettings: string;
    lastUpdatedJustNow: string;
    lastUpdatedOneMinuteAgo: string;
    /** `{count}` = minutes */
    lastUpdatedMinutesAgo: string;
    emptyTodayTitle: string;
    emptyTodayHint: string;
    loadError: string;
    statusPending: string;
    statusConfirmed: string;
    statusCompleted: string;
  };
  /** /dashboard/[slug]/settings hub */
  salonSettings: {
    pageTitle: string;
    pageIntro: string;
    sectionServices: string;
    sectionStaff: string;
    sectionHours: string;
    sectionAddress: string;
    hintRecoveryEmail: string;
  };
};

export const userEn: UserMessages = {
  brandName: "NailIQ",
  seoIntro:
    "NailIQ is an AI-powered booking and operations system for nail salons.",
  home: {
    headline: "Run your salon with NailIQ",
    subline:
      "Set up your public booking link, manage today’s appointments, and grow from one place.",
    ctaRegister: "Get started free",
    footerNote: "New here? Create your salon in a few minutes.",
    navOwnerLogin: "Owner Login",
    navOwnerLoginShort: "Login",
    alreadySalonPrefix: "Already have a salon? ",
    signInLink: "Sign in →",
  },
  register: {
    returningOwnerHint:
      "Returning owner? Enter your number to sign back in.",
    welcomeBackAfterSend:
      "Welcome back! Enter the code to access your dashboard.",
    welcomeBackVerifySubtext:
      "Welcome back! Enter the code to access your dashboard.",
    newDemoOtpBadgeNote:
      "DEMO MODE · OTP appears below.",
  },
  salonDashboard: {
    title: "Salon dashboard",
    slugLabel: "URL",
    bookingPageUrl: "Booking page",
    copyLink: "Copy link",
    copied: "Copied",
    viewBookingPage: "View booking page",
    todaySummary: "Today",
    totalToday: "Bookings",
    pending: "Pending",
    confirmed: "Confirmed",
    completed: "Completed",
    estRevenue: "Est. revenue",
    todayAppointments: "Today’s appointments",
    upcomingConfirmed: "Upcoming (confirmed)",
    noBookingsToday: "No bookings today.",
    noUpcoming: "No confirmed appointments in the next 7 days.",
    advanceStatus: "Update status",
    client: "Guest",
    service: "Service",
    salonStaffLabel: "Staff",
    phone: "Phone",
    clientNotes: "Guest notes",
    loading: "Loading…",
    refresh: "Refresh",
    navSettings: "Settings",
    lastUpdatedJustNow: "Last updated: just now",
    lastUpdatedOneMinuteAgo: "Last updated: 1 minute ago",
    lastUpdatedMinutesAgo: "Last updated: {count} minutes ago",
    emptyTodayTitle: "No bookings today yet.",
    emptyTodayHint: "Share your booking link to get started.",
    loadError: "Could not load dashboard.",
    statusPending: "Pending",
    statusConfirmed: "Confirmed",
    statusCompleted: "Completed",
  },
  salonSettings: {
    pageTitle: "Settings",
    pageIntro:
      "Manage your services, team, opening hours, and salon address—all in one place.",
    sectionServices: "Services & pricing",
    sectionStaff: "Staff",
    sectionHours: "Opening hours",
    sectionAddress: "Salon address",
    hintRecoveryEmail:
      "To add or change recovery email for your account, use the banner on your dashboard.",
  },
};
