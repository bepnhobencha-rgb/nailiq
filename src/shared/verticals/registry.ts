/**
 * Business-vertical registry — the single source of truth for everything that
 * used to be hardcoded to "nail salon".
 *
 * Each salon row carries a `salons.vertical` slug (default `"nail_salon"`).
 * Every place that previously baked in nail-specific wording — schema.org
 * `@type`, AI prompt descriptors, the default staff-role label, the booking
 * hero fallback tagline, and the seed service catalogue — now reads from
 * `resolveVertical(salon.vertical)` instead.
 *
 * Adding a new vertical (hair salon, massage, brow bar…) = add ONE entry
 * below. No migration is required: the Admin dropdown limits input to known
 * slugs and the resolver falls back to `nail_salon` for any unknown value, so
 * the column stays free-form and future-proof (per the no-hardcode rule —
 * `salons.vertical` is data, the registry is the typed default layer).
 *
 * Per-tenant fine-tuning beyond the vertical default (a custom hero tagline,
 * etc.) already exists elsewhere — `salons.description` overrides the hero
 * tagline, the my-page CMS overrides public copy — so this layer only supplies
 * sensible per-vertical DEFAULTS, never a hard ceiling.
 */

export type VerticalSeedService = {
  name: string;
  price_cents: number;
  duration_minutes: number;
  buffer_minutes: number;
};

export type VerticalConfig = {
  /** Stable slug persisted in `salons.vertical`. */
  slug: string;
  /** Admin dropdown label. */
  label: { en: string; vi: string };
  /**
   * schema.org `@type` for the public booking page LocalBusiness JSON-LD.
   * Must be a valid schema.org type (e.g. `NailSalon`, `DaySpa`, `HairSalon`,
   * `HealthAndBeautyBusiness`).
   */
  schemaType: string;
  /**
   * Short noun phrase injected into customer/AI-facing prompts, e.g.
   * "a nail salon" → "You are a booking assistant for {name}, {aiDescriptor}."
   */
  aiDescriptor: string;
  /**
   * Customer-facing label for the operational `nail_tech` staff role.
   * (The DB enum value stays `nail_tech` as a stable internal key; only the
   * display label changes per vertical.)
   */
  staffRoleLabel: { en: string; vi: string };
  /**
   * Fallback hero tagline on the public booking page, used only when the salon
   * has NOT written its own `salons.description`. Omit to fall through to the
   * generic i18n string `bookingMessages.salonHeroTagline` (this is what
   * `nail_salon` does, preserving the historical copy in both languages).
   */
  heroTagline?: { en: string; vi: string };
  /**
   * Decorative imagery for the public booking page (desktop hero panel +
   * faint ambient backdrop). Base Unsplash photo URLs WITHOUT query params —
   * consumers append sizing. Per-vertical so a head spa never shows nail
   * photos. (Future: per-salon override from the salon's own photos.)
   */
  bookingImagery: { hero: string; thumbA: string; thumbB: string };
  /**
   * Whether the booking flow offers the optional "reference image" upload by
   * default. Useful for visual/design services (nail, hair) where a customer
   * shows the look they want; pointless for relaxation services (head spa,
   * massage). Per-salon `salons.reference_image_enabled` overrides this.
   */
  referenceImageEnabled: boolean;
  /** Default catalogue seeded for a brand-new salon of this vertical. */
  seedServices: VerticalSeedService[];
};

// ---------------------------------------------------------------------------
// Seed catalogues
// ---------------------------------------------------------------------------

/** Historical nail-salon starter menu (moved verbatim out of
 *  `completeSalonRegistrationAction`). */
const NAIL_SALON_SEED: VerticalSeedService[] = [
  { name: "Gel Manicure", price_cents: 3500, duration_minutes: 30, buffer_minutes: 10 },
  { name: "Regular Manicure", price_cents: 2500, duration_minutes: 25, buffer_minutes: 10 },
  { name: "Gel Pedicure", price_cents: 5000, duration_minutes: 45, buffer_minutes: 10 },
  { name: "Regular Pedicure", price_cents: 4000, duration_minutes: 35, buffer_minutes: 10 },
  { name: "Acrylic Full Set", price_cents: 5500, duration_minutes: 60, buffer_minutes: 10 },
  { name: "Acrylic Fill", price_cents: 4000, duration_minutes: 45, buffer_minutes: 10 },
  { name: "Dip Powder (SNS)", price_cents: 5000, duration_minutes: 50, buffer_minutes: 10 },
  { name: "Gel Removal", price_cents: 1000, duration_minutes: 15, buffer_minutes: 5 },
  { name: "Acrylic Removal", price_cents: 1500, duration_minutes: 20, buffer_minutes: 5 },
  { name: "Polish Change", price_cents: 1500, duration_minutes: 15, buffer_minutes: 5 },
  { name: "French Tips Add-on", price_cents: 1000, duration_minutes: 10, buffer_minutes: 5 },
  { name: "Pedicure Spa Deluxe", price_cents: 6500, duration_minutes: 60, buffer_minutes: 10 },
];

/** Head-spa starter menu (scalp / relaxation treatments). Mirrors the common
 *  package-tier shape (Standard / Royal) plus à-la-carte scalp services. */
const HEAD_SPA_SEED: VerticalSeedService[] = [
  { name: "Express Head Spa", price_cents: 3500, duration_minutes: 30, buffer_minutes: 10 },
  { name: "Standard Head Spa (Massage · Exfoliation · Wash · Blowout)", price_cents: 5500, duration_minutes: 60, buffer_minutes: 10 },
  { name: "Royal Head Spa (Standard + Neck & Leg Massage)", price_cents: 7500, duration_minutes: 75, buffer_minutes: 15 },
  { name: "Signature Scalp Treatment", price_cents: 6000, duration_minutes: 60, buffer_minutes: 10 },
  { name: "Deep Cleansing Scalp Detox", price_cents: 5000, duration_minutes: 50, buffer_minutes: 10 },
  { name: "Hair & Scalp Nourishing Mask", price_cents: 4000, duration_minutes: 40, buffer_minutes: 10 },
  { name: "Scalp Massage (30 min)", price_cents: 3000, duration_minutes: 30, buffer_minutes: 5 },
  { name: "Neck & Shoulder Massage Add-on", price_cents: 2000, duration_minutes: 20, buffer_minutes: 5 },
];

// ---------------------------------------------------------------------------
// Vertical definitions
// ---------------------------------------------------------------------------

const NAIL_SALON: VerticalConfig = {
  slug: "nail_salon",
  label: { en: "Nail salon", vi: "Tiệm nail" },
  schemaType: "NailSalon",
  aiDescriptor: "a nail salon",
  staffRoleLabel: { en: "Nail Tech", vi: "Thợ nail" },
  // No heroTagline → falls through to the existing i18n copy in both langs.
  // Preserves the historical hardcoded booking imagery for nail salons.
  bookingImagery: {
    hero: "https://images.unsplash.com/photo-1610992015732-2449b76344bc",
    thumbA: "https://images.unsplash.com/photo-1604654894610-df63bc536371",
    thumbB: "https://images.unsplash.com/photo-1522337360788-8b13dee7a37e",
  },
  referenceImageEnabled: true,
  seedServices: NAIL_SALON_SEED,
};

const HEAD_SPA: VerticalConfig = {
  slug: "head_spa",
  label: { en: "Head spa", vi: "Head spa" },
  schemaType: "DaySpa",
  aiDescriptor: "a head spa offering scalp and relaxation treatments",
  staffRoleLabel: { en: "Therapist", vi: "Kỹ thuật viên" },
  // Calm head-spa / wellness imagery (verified Unsplash, no nail photos).
  bookingImagery: {
    hero: "https://images.unsplash.com/photo-1540555700478-4be289fbecef",
    thumbA: "https://images.unsplash.com/photo-1556228578-8c89e6adf883",
    thumbB: "https://images.unsplash.com/photo-1583416750470-965b2707b355",
  },
  heroTagline: {
    en: "A calm sanctuary for scalp care and deep relaxation — your visit begins here.",
    vi: "Không gian thư giãn cho da đầu và tóc — hành trình của bạn bắt đầu tại đây.",
  },
  referenceImageEnabled: false,
  seedServices: HEAD_SPA_SEED,
};

// ---------------------------------------------------------------------------
// Registry + resolver
// ---------------------------------------------------------------------------

export const VERTICALS: Record<string, VerticalConfig> = {
  [NAIL_SALON.slug]: NAIL_SALON,
  [HEAD_SPA.slug]: HEAD_SPA,
};

/** Default vertical for legacy rows and brand-new registrations. */
export const DEFAULT_VERTICAL = NAIL_SALON.slug;

/**
 * Resolve a `salons.vertical` value into its config. Unknown / null / legacy
 * values fall back to `nail_salon` so callers never have to null-check.
 */
export function resolveVertical(slug?: string | null): VerticalConfig {
  const key = typeof slug === "string" ? slug.trim().toLowerCase() : "";
  return VERTICALS[key] ?? VERTICALS[DEFAULT_VERTICAL];
}

export function isKnownVertical(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    VERTICALS,
    slug.trim().toLowerCase(),
  );
}

/** Options for the Admin Settings dropdown. */
export const VERTICAL_OPTIONS: ReadonlyArray<{
  slug: string;
  label: { en: string; vi: string };
}> = Object.values(VERTICALS).map((v) => ({ slug: v.slug, label: v.label }));
