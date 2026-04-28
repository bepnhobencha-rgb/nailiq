/**
 * User-facing copy (owner / dashboard / marketing): English (default).
 */
export type UserMessages = {
  brandName: string;
  /**
   * Primary h1. Use `\n` (optional) for a two-line first paint on small screens;
   * still reads as one sentence to assistive tech.
   */
  heroHeadline: string;
  /** One short line under the headline (hero only) */
  heroSubline: string;
  /** Plain-language product summary for crawlers and readers */
  seoIntro: string;
  benefitsHeading: string;
  benefits: readonly {
    title: string;
    body: string;
    /**
     * When set, the landing hero iPhone cross-fades to this scene when the
     * benefit is in view.
     */
    phoneScene?: "booking" | "ai";
  }[];
  tagline: string;
  setupTime: string;
  /** Primary CTA (hero) */
  cta: string;
  phonePlaceholder: string;
  phoneHint: string;
  valueCardTitle: string;
  valueCardBadge: string;
  valueCardBody: string;
  /** Small footer line; distributed brand touchpoint */
  footerPoweredBy: string;
  phoneScreenBody: string;
  /** Rotating labels in the phone preview (3 items) */
  serviceStrip: readonly [string, string, string];
  /** FOMO line below primary CTA */
  urgencyLine: string;
  /** Rotating one-line “live” social proof (2+ items) */
  liveProof: readonly [string, string];
  /** One line under the hero phone booking card (+1 new booking) */
  phoneHeroMicroLine: string;
  wowHeading: string;
  /** Two short lines; use `\n` for line break in the second block */
  wowBody: string;
  /** CTA subline, directly under the primary button */
  ctaSubline: string;
  /** Micro trust under CTA stack (setup speed) */
  ctaTrustLine: string;
  /** In-phone “live” notification rows (rotates in PhoneFrame) */
  phoneActivity: readonly { label: string; line: string }[];
  /** Time row in the phone mock (3 slots) */
  phoneTimeSlots: readonly [string, string, string];
  /** In-phone: booking flow app bar title */
  phoneBookingSceneTitle: string;
  phoneBookingStepService: string;
  phoneBookingStepTime: string;
  phoneBookingStepComplete: string;
  phoneBookingContinue: string;
  phoneBookingBack: string;
  phoneBookingDoneTitle: string;
  phoneBookingDoneSubtitle: string;
  phoneBookingDateLine: string;
  phoneBookingBookAnother: string;
  /** In-phone: AI menu scan scene label */
  phoneAiSceneLabel: string;
  /** In-phone: “live” line under AI menu placeholder */
  phoneAiSceneHint: string;
  /** Placeholder in demo service list (not tenant data; UI sample) */
  phoneMenuDemoRows: readonly {
    category: string;
    name: string;
    price: string;
  }[];
  /** Salon owner dashboard (`/dashboard/[slug]`) */
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
    phone: string;
    loading: string;
    loadError: string;
    statusPending: string;
    statusConfirmed: string;
    statusCompleted: string;
  };
};

export const userEn: UserMessages = {
  brandName: "NailIQ",
  heroHeadline: "Clients keep booking you\neven when you're fully booked",
  heroSubline:
    "Your salon keeps getting bookings — even when you can't answer the phone",
  seoIntro:
    "NailIQ is an AI-powered booking, automation, and growth system for nail salons. It helps you take appointments online, cut missed calls, and run a calmer front desk—without adding more tools to juggle.",
  benefitsHeading: "What you get with NailIQ",
  benefits: [
    {
      title: "Bookings that run themselves",
      body: "Clients pick services and times that match your rules, so your calendar stays full while you stay focused on the chair.",
      phoneScene: "booking",
    },
    {
      title: "AI Genesis: your menu, organized",
      body: "Scan a paper menu or price list—NailIQ turns it into a clean, bookable service list in seconds.",
      phoneScene: "ai",
    },
    {
      title: "One system for growth",
      body: "Website, scheduling, and automation live together so marketing, operations, and client experience stay consistent.",
    },
  ] as const,
  tagline: "Your salon gets booked — even when you're busy",
  setupTime: "Most salons finish setup in under 2 minutes.",
  cta: "Get your first booking in 2 minutes",
  ctaSubline: "No app. No setup.",
  ctaTrustLine: "Takes less than 2 minutes to start getting bookings.",
  phonePlaceholder: "Enter your phone number to get your booking link",
  phoneHint: "We'll text you your booking link instantly",
  phoneHeroMicroLine: "+1 new booking",
  wowHeading: "Your salon can run on autopilot",
  wowBody: "Bookings. Reminders. Growth.\nAll handled automatically.",
  valueCardTitle: "The calm, confident front door",
  valueCardBadge: "NailIQ",
  footerPoweredBy: "Powered by NailIQ",
  valueCardBody:
    "A single glass surface for booking, your menu, and the little details that make your studio feel expensive—before a guest even walks in.",
  phoneScreenBody:
    "Your link, your brand, your rules—served in one iPhone-tight experience clients actually use.",
  serviceStrip: ["Pedicure", "Manicure", "Gel"],
  urgencyLine: "⚡ Most salons lose 3–7 bookings daily from missed calls",
  liveProof: [
    "Anna got booked 2 minutes ago",
    "Lisa filled 3 slots today",
  ] as const,
  phoneActivity: [
    { label: "Anna booked", line: "3:00 PM — Pedicure • $45" },
    { label: "Jenny booked", line: "2:15 PM — Gel • $38" },
  ] as const,
  phoneTimeSlots: ["3:00 PM", "3:30 PM", "4:00 PM"] as const,
  phoneBookingSceneTitle: "Book",
  phoneBookingStepService: "Service",
  phoneBookingStepTime: "Time",
  phoneBookingStepComplete: "Done",
  phoneBookingContinue: "Continue",
  phoneBookingBack: "Back",
  phoneBookingDoneTitle: "You're booked",
  phoneBookingDoneSubtitle:
    "We'll send a confirmation with the time you picked.",
  phoneBookingDateLine: "Today · Sat, Apr 25",
  phoneBookingBookAnother: "Book again",
  phoneAiSceneLabel: "Menu scan",
  phoneAiSceneHint: "Point at your menu",
  phoneMenuDemoRows: [
    { category: "Manicure", name: "Classic Manicure", price: "$45" },
    { category: "Manicure", name: "Gel Rebalance", price: "$55" },
    { category: "Pedicure", name: "Spa Pedicure", price: "$60" },
    { category: "Pedicure", name: "Express Pedicure", price: "$48" },
  ] as const,
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
    phone: "Phone",
    loading: "Loading…",
    loadError: "Could not load dashboard.",
    statusPending: "Pending",
    statusConfirmed: "Confirmed",
    statusCompleted: "Completed",
  },
};
