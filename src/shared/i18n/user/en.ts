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
  }[];
  tagline: string;
  setupTime: string;
  /** Primary CTA (hero) */
  cta: string;
  phonePlaceholder: string;
  phoneHint: string;
  socialProof: string;
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
  /** Rotating one-line “live” proof below phone input (2+ items) */
  liveProof: readonly [string, string];
  /** CTA subline, directly under the primary button */
  ctaSubline: string;
  /** Micro trust under CTA stack (setup speed) */
  ctaTrustLine: string;
  /** In-phone “live” notification rows (rotates in PhoneFrame) */
  phoneActivity: readonly { label: string; line: string }[];
};

export const userEn: UserMessages = {
  brandName: "NailIQ",
  heroHeadline: "Clients book you\neven when you're fully booked",
  heroSubline: "Get booked — even when you're busy",
  seoIntro:
    "NailIQ is an AI-powered booking, automation, and growth system for nail salons. It helps you take appointments online, cut missed calls, and run a calmer front desk—without adding more tools to juggle.",
  benefitsHeading: "What you get with NailIQ",
  benefits: [
    {
      title: "Bookings that run themselves",
      body: "Clients pick services and times that match your rules, so your calendar stays full while you stay focused on the chair.",
    },
    {
      title: "A front desk that never goes dark",
      body: "AI-assisted booking and reminders reduce no-shows and last-minute gaps, even when the phone is blowing up.",
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
  ctaTrustLine: "Takes less than 2 minutes to set up",
  phonePlaceholder: "Enter your phone number",
  phoneHint: "We'll text you your booking link instantly",
  socialProof: "100+ salons already using NailIQ",
  valueCardTitle: "The calm, confident front door",
  valueCardBadge: "NailIQ",
  footerPoweredBy: "Powered by NailIQ",
  valueCardBody:
    "A single glass surface for booking, your menu, and the little details that make your studio feel expensive—before a guest even walks in.",
  phoneScreenBody:
    "Your link, your brand, your rules—served in one iPhone-tight experience clients actually use.",
  serviceStrip: ["Pedicure", "Gel", "Manicure"],
  urgencyLine: "⚡ You may miss 3–7 bookings today",
  liveProof: [
    "Anna just got booked • 2 min ago",
    "Jenny filled 5 slots today",
  ] as const,
  phoneActivity: [
    { label: "New booking", line: "3:00 PM — Pedicure • $45" },
    { label: "New booking", line: "2:15 PM — Gel • $38" },
  ] as const,
};
