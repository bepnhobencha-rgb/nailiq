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
   * Service-type noun + service-risk sentence used in the customer-facing legal
   * templates (Cancellation Policy + Booking Terms), so a nail salon reads
   * differently from a head spa. Bilingual.
   */
  legalServiceNoun: { en: string; vi: string };
  legalServiceRisk: { en: string; vi: string };
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
  legalServiceNoun: { en: "nail service", vi: "dịch vụ làm nail" },
  legalServiceRisk: {
    en: "Some nail services use chemical products and tools. Please tell us about any allergies, skin/nail conditions, or recent injuries before your service.",
    vi: "Một số dịch vụ nail dùng hoá chất và dụng cụ. Vui lòng báo trước về dị ứng, tình trạng da/móng hoặc vết thương gần đây.",
  },
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
  legalServiceNoun: { en: "head spa treatment", vi: "dịch vụ head spa" },
  legalServiceRisk: {
    en: "Some scalp/hair treatments use products and warm water. Please tell us about scalp sensitivity, allergies, or any health conditions (e.g. neck/back) before your treatment.",
    vi: "Một số liệu trình da đầu/tóc dùng sản phẩm và nước ấm. Vui lòng báo trước về da đầu nhạy cảm, dị ứng hoặc tình trạng sức khoẻ (vd cổ/lưng).",
  },
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
// Additional verticals. Imagery reuses the verified wellness photo set as a
// safe default (no broken images); a salon can override with its own photos.
// Seed menus are concise sensible starters. Legal service-risk wording is
// tailored per service type (the customer Booking Terms read differently).
// ---------------------------------------------------------------------------

const WELLNESS_IMAGERY = HEAD_SPA.bookingImagery;

const HAIR_SALON: VerticalConfig = {
  slug: "hair_salon",
  label: { en: "Hair salon", vi: "Tiệm tóc" },
  schemaType: "HairSalon",
  aiDescriptor: "a hair salon",
  legalServiceNoun: { en: "hair service", vi: "dịch vụ làm tóc" },
  legalServiceRisk: {
    en: "Some hair services use chemical products (colour, perms, relaxers, bleach). Please tell us about allergies, scalp/skin sensitivity, or recent chemical treatments; a patch test may be recommended.",
    vi: "Một số dịch vụ tóc dùng hoá chất (nhuộm, uốn, duỗi, tẩy). Vui lòng báo về dị ứng, da đầu/da nhạy cảm hoặc đã làm hoá chất gần đây; có thể cần test thử trước.",
  },
  staffRoleLabel: { en: "Stylist", vi: "Thợ tóc" },
  bookingImagery: WELLNESS_IMAGERY,
  referenceImageEnabled: true,
  seedServices: [
    { name: "Women's Haircut", price_cents: 4500, duration_minutes: 45, buffer_minutes: 10 },
    { name: "Men's Haircut", price_cents: 3000, duration_minutes: 30, buffer_minutes: 10 },
    { name: "Blowout & Style", price_cents: 4000, duration_minutes: 40, buffer_minutes: 10 },
    { name: "Full Colour", price_cents: 9000, duration_minutes: 120, buffer_minutes: 15 },
    { name: "Highlights / Balayage", price_cents: 14000, duration_minutes: 150, buffer_minutes: 15 },
    { name: "Root Touch-up", price_cents: 7000, duration_minutes: 90, buffer_minutes: 10 },
  ],
};

const FACIAL_SKIN: VerticalConfig = {
  slug: "facial",
  label: { en: "Facial & skincare", vi: "Facial & chăm sóc da" },
  schemaType: "DaySpa",
  aiDescriptor: "a facial and skincare studio",
  legalServiceNoun: { en: "facial / skincare service", vi: "dịch vụ facial / chăm sóc da" },
  legalServiceRisk: {
    en: "Facials apply products and treatments to the skin and can cause redness or reactions. Please tell us about allergies, skin conditions, recent peels/lasers, or retinoid/Accutane use before your service.",
    vi: "Facial dùng sản phẩm và liệu trình lên da, có thể gây đỏ hoặc phản ứng. Vui lòng báo về dị ứng, tình trạng da, vừa peel/laser, hoặc đang dùng retinoid/Accutane.",
  },
  staffRoleLabel: { en: "Esthetician", vi: "Chuyên viên da" },
  bookingImagery: WELLNESS_IMAGERY,
  referenceImageEnabled: false,
  seedServices: [
    { name: "Express Facial", price_cents: 5000, duration_minutes: 30, buffer_minutes: 10 },
    { name: "Signature Facial", price_cents: 8500, duration_minutes: 60, buffer_minutes: 10 },
    { name: "Deep-Cleansing / Acne Facial", price_cents: 9500, duration_minutes: 75, buffer_minutes: 10 },
    { name: "Anti-Aging Facial", price_cents: 12000, duration_minutes: 75, buffer_minutes: 15 },
    { name: "Chemical Peel", price_cents: 11000, duration_minutes: 45, buffer_minutes: 15 },
    { name: "Microdermabrasion", price_cents: 10000, duration_minutes: 60, buffer_minutes: 10 },
  ],
};

const MASSAGE_SPA: VerticalConfig = {
  slug: "massage",
  label: { en: "Massage & spa", vi: "Massage & spa" },
  schemaType: "DaySpa",
  aiDescriptor: "a massage and spa studio",
  legalServiceNoun: { en: "massage / spa service", vi: "dịch vụ massage / spa" },
  legalServiceRisk: {
    en: "Massage involves physical pressure. Please tell us about pregnancy, injuries, recent surgery, blood-pressure or other health conditions so we can adjust or recommend against a service.",
    vi: "Massage có tác động lực. Vui lòng báo nếu đang mang thai, có chấn thương, vừa phẫu thuật, huyết áp hoặc tình trạng sức khoẻ khác để điều chỉnh hoặc tư vấn phù hợp.",
  },
  staffRoleLabel: { en: "Therapist", vi: "Kỹ thuật viên" },
  bookingImagery: WELLNESS_IMAGERY,
  referenceImageEnabled: false,
  seedServices: [
    { name: "Relaxation Massage (60 min)", price_cents: 8000, duration_minutes: 60, buffer_minutes: 10 },
    { name: "Deep Tissue Massage (60 min)", price_cents: 9000, duration_minutes: 60, buffer_minutes: 10 },
    { name: "Hot Stone Massage", price_cents: 11000, duration_minutes: 75, buffer_minutes: 15 },
    { name: "Couples Massage", price_cents: 16000, duration_minutes: 60, buffer_minutes: 15 },
    { name: "Foot Reflexology", price_cents: 5000, duration_minutes: 30, buffer_minutes: 5 },
  ],
};

const WAXING: VerticalConfig = {
  slug: "waxing",
  label: { en: "Waxing & hair removal", vi: "Waxing & tẩy lông" },
  schemaType: "HealthAndBeautyBusiness",
  aiDescriptor: "a waxing and hair-removal studio",
  legalServiceNoun: { en: "waxing service", vi: "dịch vụ waxing" },
  legalServiceRisk: {
    en: "Waxing removes hair from the skin and can cause redness, irritation or lifting. Please tell us about skin sensitivity, recent sun/tanning, or retinoid/Accutane use, which can make waxing unsafe.",
    vi: "Waxing lấy lông khỏi da, có thể gây đỏ, kích ứng hoặc tróc da. Vui lòng báo về da nhạy cảm, vừa phơi nắng/tắm nắng, hoặc đang dùng retinoid/Accutane (có thể không nên wax).",
  },
  staffRoleLabel: { en: "Wax Specialist", vi: "Chuyên viên wax" },
  bookingImagery: WELLNESS_IMAGERY,
  referenceImageEnabled: false,
  seedServices: [
    { name: "Eyebrow Wax", price_cents: 1500, duration_minutes: 15, buffer_minutes: 5 },
    { name: "Lip / Chin Wax", price_cents: 1200, duration_minutes: 10, buffer_minutes: 5 },
    { name: "Underarm Wax", price_cents: 2000, duration_minutes: 15, buffer_minutes: 5 },
    { name: "Full Leg Wax", price_cents: 6000, duration_minutes: 45, buffer_minutes: 10 },
    { name: "Brazilian Wax", price_cents: 6500, duration_minutes: 30, buffer_minutes: 10 },
  ],
};

const LASH_BROW: VerticalConfig = {
  slug: "lash_brow",
  label: { en: "Lash & brow", vi: "Mi & chân mày" },
  schemaType: "HealthAndBeautyBusiness",
  aiDescriptor: "a lash and brow studio",
  legalServiceNoun: { en: "lash / brow service", vi: "dịch vụ mi / chân mày" },
  legalServiceRisk: {
    en: "Lash and brow services work near the eyes and use adhesives or tints that can cause irritation or allergic reaction. Please tell us about sensitivities; a patch test may be recommended.",
    vi: "Dịch vụ mi/chân mày làm gần mắt và dùng keo/thuốc nhuộm có thể gây kích ứng hoặc dị ứng. Vui lòng báo về nhạy cảm; có thể cần test thử trước.",
  },
  staffRoleLabel: { en: "Lash & Brow Artist", vi: "Chuyên viên mi & mày" },
  bookingImagery: WELLNESS_IMAGERY,
  referenceImageEnabled: true,
  seedServices: [
    { name: "Classic Lash Set", price_cents: 9000, duration_minutes: 90, buffer_minutes: 10 },
    { name: "Volume Lash Set", price_cents: 12000, duration_minutes: 120, buffer_minutes: 15 },
    { name: "Lash Fill", price_cents: 5500, duration_minutes: 60, buffer_minutes: 10 },
    { name: "Lash Lift & Tint", price_cents: 7000, duration_minutes: 60, buffer_minutes: 10 },
    { name: "Brow Lamination", price_cents: 6500, duration_minutes: 45, buffer_minutes: 10 },
    { name: "Brow Tint & Shape", price_cents: 3500, duration_minutes: 30, buffer_minutes: 5 },
  ],
};

const BARBERSHOP: VerticalConfig = {
  slug: "barbershop",
  label: { en: "Barbershop", vi: "Tiệm cắt tóc nam" },
  schemaType: "HairSalon",
  aiDescriptor: "a barbershop",
  legalServiceNoun: { en: "barbering service", vi: "dịch vụ cắt tóc nam" },
  legalServiceRisk: {
    en: "Barbering uses clippers and razors near the skin. Please tell us about skin sensitivity, conditions, or recent injuries before your service.",
    vi: "Cắt tóc nam dùng tông đơ và dao cạo gần da. Vui lòng báo về da nhạy cảm, tình trạng da hoặc vết thương gần đây.",
  },
  staffRoleLabel: { en: "Barber", vi: "Thợ cắt tóc" },
  bookingImagery: WELLNESS_IMAGERY,
  referenceImageEnabled: true,
  seedServices: [
    { name: "Haircut", price_cents: 3000, duration_minutes: 30, buffer_minutes: 5 },
    { name: "Haircut & Beard Trim", price_cents: 4000, duration_minutes: 45, buffer_minutes: 10 },
    { name: "Beard Trim & Shape", price_cents: 2000, duration_minutes: 20, buffer_minutes: 5 },
    { name: "Hot Towel Shave", price_cents: 3500, duration_minutes: 30, buffer_minutes: 10 },
    { name: "Kids Haircut", price_cents: 2500, duration_minutes: 25, buffer_minutes: 5 },
  ],
};

// ---------------------------------------------------------------------------
// Registry + resolver
// ---------------------------------------------------------------------------

export const VERTICALS: Record<string, VerticalConfig> = {
  [NAIL_SALON.slug]: NAIL_SALON,
  [HEAD_SPA.slug]: HEAD_SPA,
  [HAIR_SALON.slug]: HAIR_SALON,
  [FACIAL_SKIN.slug]: FACIAL_SKIN,
  [MASSAGE_SPA.slug]: MASSAGE_SPA,
  [WAXING.slug]: WAXING,
  [LASH_BROW.slug]: LASH_BROW,
  [BARBERSHOP.slug]: BARBERSHOP,
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
