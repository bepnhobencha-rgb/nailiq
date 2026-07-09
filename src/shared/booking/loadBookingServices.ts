import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/nextjs";
import type { BookingComboItem, BookingServiceItem } from "@/shared/booking/catalog";
import { getSalonBySlug } from "@/shared/booking/getSalonBySlug";
import { resolveVertical } from "@/shared/verticals/registry";
import { parseServiceCategory } from "@/shared/booking/serviceCategory";
import { serviceBlockMinutes } from "@/shared/booking/bookingBlock";
import { isReleaseFeatureEnabled } from "@/shared/features/featureRegistry";
import { createClient } from "@/shared/lib/supabase/server";
import { normalizeBrandColor } from "@/shared/lib/brandColor";
import {
  formatServicePrice,
  parseCurrency,
  type Currency,
} from "@/shared/lib/currencyFormat";

export type BookingStaffItem = {
  id: string;
  name: string;
  job_role: string;
};

export type BookingSalonMeta = {
  id: string;
  name: string;
  opening_hours: unknown | null;
  /** JSONB array of YYYY-MM-DD (holidays / exceptions). */
  booking_closed_dates: unknown | null;
  /** Flowchart: salon must be “live” (Phase 2 checklist complete). */
  acceptingBookings: boolean;
  /** Public contact for “manage booking” (call to reschedule). DB: `salons.salon_phone` only — never `salons.phone` (owner). */
  salonPhone: string | null;
  /** The salon's OWN policy pages, linked next to the SMS-consent checkbox.
   *  Twilio wants the registered business's policies, not the platform's.
   *  NULL → the booking page falls back to NailIQ's /privacy and /terms. */
  privacyUrl: string | null;
  termsUrl: string | null;
  /** `salons.default_language` — last-resort booking locale. NULL → "vi". */
  defaultLanguage: "en" | "vi" | null;
  /** `salons.logo_url` — shown on the booking header so a guest arriving from
   *  the salon's own site sees the same brand. NULL → name only. */
  logoUrl: string | null;
  /** IANA TZ for slot-grid label and confirmation copy (B-16). DB column is NOT NULL DEFAULT 'America/Los_Angeles'; "UTC" is a paranoid fallback. */
  timezone: string;
  /** Per-salon primary color for the booking page (PR #109). Always
   * a `#RRGGBB` literal — `normalizeBrandColor` falls back to the
   * default gold when the column is missing or invalid. */
  brandColor: string;
  /** Per-salon light/dark theme for the public booking page only.
   * Defaults to `"dark"` for legacy rows and any invalid value. */
  themeMode: "dark" | "light";
  /** Salon's display currency (CAD / USD / VND). Service prices and
   *  totals on the booking page render in this currency. */
  currencyCode: Currency;
  /** Public street address (`salons.address`). Single free-form text
   * column — caller renders verbatim. `null` when the owner hasn't
   * completed the Address setup step. */
  address: string | null;
  /** P2.8 — owner-editable salon description rendered as the booking
   * page tagline. `null` falls back to the generic copy in
   * `bookingEn.salonHeroTagline`. */
  description: string | null;
  /** When true, the booking flow shows an SMS OTP step to verify the
   *  customer's phone before confirming. Driven by `salons.phone_otp_enabled`. */
  phoneOtpEnabled: boolean;
  /** When true, the Voice AI booking button is shown on the public booking page. */
  voiceAiEnabled: boolean;
  /** Release flag `group_booking` (PR2). When false, the public booking page
   *  hides the Individual/Group toggle and renders the individual flow only. */
  groupBookingEnabled: boolean;
  /** `salons.vertical` slug (nail_salon | head_spa | …). Drives schema.org
   *  type, staff-role label, and hero tagline fallback. Defaults to
   *  `"nail_salon"` for legacy rows. */
  vertical: string;
  /** `salons.public_sections_enabled` — when true, the salon's website-builder
   *  sections render above the booking flow on the public page. Default false. */
  publicSectionsEnabled: boolean;
  /** `salons.booking_images` — per-salon override for booking page hero/ambient
   *  imagery. Null → use the vertical default. */
  bookingImages: { hero: string; thumbA: string; thumbB: string } | null;
  /** `salons.staff_selection_enabled` — when false the wizard hides the staff
   *  step and auto-assigns any available provider. Default true. */
  staffSelectionEnabled: boolean;
  /** `salons.booking_lead_minutes` — minimum same-day advance notice. Default 15. */
  bookingLeadMinutes: number;
  /** `salons.group_together_threshold_minutes` — group members within this
   *  spread still count as "together"; drives the partial-vs-all-together
   *  ordering in the group flow. Default 30. */
  groupTogetherThresholdMin: number;
  /** Whether the booking flow offers the optional reference-image upload.
   *  Resolved from salons.reference_image_enabled ?? vertical default. */
  referenceImageEnabled: boolean;
  /** `salons.health_ack_required` override (NULL → vertical default). Drives the
   *  mandatory health-acknowledgment tick for body/treatment services. */
  healthAckRequired: boolean | null;
  /** `salons.email_links_enabled` (default true). Gates the OTP email fallback
   *  + link emails. NULL/undefined treated as true by consumers. */
  emailLinksEnabled: boolean | null;
  /** True when `salons.resources_enabled` is on — beds/chairs must be assigned. */
  resourcesEnabled: boolean;
  /** Tax lines configured for this salon. Shown as a breakdown in the confirm
   *  step. Empty array = no tax. Computed client-side for display; re-computed
   *  server-side on submit and stamped on the booking row. */
  taxLines: import("@/shared/tax/taxTypes").TaxLine[];
};

export type BookingLoadData = {
  /** Exact `salons.slug` from DB — pass to BookingFlow/submit lookups. */
  canonicalSlug: string;
  services: BookingServiceItem[];
  /** Add-on services (is_addon) — upsell-only, not in the main picker. */
  addOns: BookingServiceItem[];
  /** Active combo bundles for this salon. Empty when none defined. */
  combos: BookingComboItem[];
  staff: BookingStaffItem[];
  /** Per-staff service whitelist. `null` = salon has no rows → all-capable fallback. */
  capabilityRows: { staff_id: string; service_id: string }[] | null;
  salon: BookingSalonMeta;
  /** Active beds/chairs/stations for resource-mode salons. Empty otherwise. */
  resources: { id: string; name: string; displayOrder: number }[];
};

/**
 * Booking flowchart step 4 — load booking data for the salon.
 * Caller must pass a slug already normalized + validated (`resolvePublicBookingPage`).
 *
 * When `supabase` is omitted, uses `createClient()` from `@/shared/lib/supabase/server` (cookies).
 * Pass a `@supabase/supabase-js` client for scripts outside the Next.js request scope.
 * Public catalog reads rely on RLS policies for anonymous access.
 */
export async function loadBookingServicesForSalonSlug(
  normalizedSlug: string,
  supabase?: SupabaseClient,
): Promise<BookingLoadData | null> {
  const client = supabase ?? (await createClient());

  const { salon, error: salonErr } = await getSalonBySlug(
    client,
    normalizedSlug,
  );

  if (salonErr) {
    console.error("[PUBLIC_BOOKING] loadBookingServices salon error:", salonErr);
    Sentry.captureException(salonErr, {
      tags: {
        "salon.slug": normalizedSlug,
        surface: "public_booking_load",
      },
      extra: {
        code: salonErr.code,
        hint: salonErr.message,
      },
    });
    return null;
  }
  if (!salon) {
    return null;
  }

  const canonicalSlug = String((salon as { slug?: string }).slug ?? "").trim();
  if (!canonicalSlug) {
    return null;
  }

  const salonId = String(salon.id ?? "");
  if (!salonId) return null;

  const { data: rows, error: servicesErr } = await client
    .from("services")
    // `category`, `description`, `is_popular`, `is_featured` were added
    // in migrations 20260511500000 and 20260511600000; `price_type` and
    // `price_max_cents` by the variable-pricing migration. Not yet in the
    // auto-generated DB types so the SELECT spread is cast.
    .select(
      "id, name, duration_minutes, buffer_minutes, price_cents, price_type, price_max_cents, category, description, is_popular, is_featured, is_addon, addon_timing" as never,
    )
    .eq("salon_id", salonId)
    .is("deleted_at" as never, null)
    .order("name", { ascending: true });

  if (servicesErr) {
    console.error("loadBookingServices error:", servicesErr);
  }

  // Public booking only sees `active` staff. `pending` and `inactive` rows
  // remain in the dashboard for the owner but never surface to customers.
  const { data: staffList, error: staffErr } = await client
    .from("staff")
    .select("id, name, job_role")
    .eq("salon_id", salonId)
    .eq("status", "active")
    .is("deleted_at" as never, null)
    .order("name", { ascending: true });

  if (staffErr) {
    console.error("loadBookingServices staff error:", staffErr);
  }

  const salonCurrency = parseCurrency(
    (salon as { currency_code?: unknown }).currency_code,
  );

  // Initialized here (before mapServiceRow) to avoid TDZ: Turbopack does not
  // hoist `function` declarations inside async functions the same way V8 does,
  // so if resolveServicePromo is declared as a function declaration later in
  // the body and closes over these const variables, it throws
  // "Cannot access 'X' before initialization" in the compiled output.
  // Using let + empty-array initialization guarantees they're always defined
  // when mapServiceRow / resolveServicePromo are called.
  type PromoListItem = {
    id: string; name: string; discount_type: string; discount_value: number;
    applies_to: string; days_of_week: number[] | null; time_start: string | null; time_end: string | null;
  };
  type PromoSvcRuleItem = { promotion_id: string; service_id: string; discount_type: string | null; discount_value: number | null };

  let promoList: PromoListItem[] = [];
  let promoSvcRules: PromoSvcRuleItem[] = [];

  function calcDiscount(baseCents: number, dtype: string, value: number): number {
    if (dtype === "fixed_price") return Math.max(0, baseCents - value);
    if (dtype === "amount") return Math.min(value, baseCents);
    if (dtype === "percent") return Math.round((baseCents * value) / 10000);
    return 0;
  }

  function resolveServicePromo(serviceId: string, baseCents: number | null): {
    promoId: string | null;
    promoName: string | null;
    promoPriceCents: number | null;
  } {
    if (!baseCents || !promoList.length) return { promoId: null, promoName: null, promoPriceCents: null };
    const svcRuleMap = new Map<string, { discount_type: string; discount_value: number }>();
    for (const r of promoSvcRules) {
      if (r.service_id === serviceId && r.discount_type && r.discount_value != null) {
        svcRuleMap.set(r.promotion_id, { discount_type: r.discount_type, discount_value: r.discount_value });
      }
    }
    let bestId: string | null = null;
    let bestName: string | null = null;
    let bestDiscount = 0;
    for (const p of promoList) {
      const svcRule = svcRuleMap.get(p.id);
      let dtype: string;
      let dvalue: number;
      if (svcRule) {
        dtype = svcRule.discount_type;
        dvalue = svcRule.discount_value;
      } else if (p.applies_to === "all") {
        dtype = p.discount_type;
        dvalue = p.discount_value;
      } else {
        continue;
      }
      const disc = calcDiscount(baseCents, dtype, dvalue);
      if (disc > bestDiscount) {
        bestDiscount = disc;
        bestId = p.id;
        bestName = p.name;
      }
    }
    if (!bestId || bestDiscount <= 0) return { promoId: null, promoName: null, promoPriceCents: null };
    return { promoId: bestId, promoName: bestName, promoPriceCents: Math.max(0, baseCents - bestDiscount) };
  }

  const mapServiceRow = (r: unknown): BookingServiceItem => {
    const row = r as unknown as {
      id: string;
      name: string;
      duration_minutes?: unknown;
      buffer_minutes?: unknown;
      price_cents?: unknown;
      price_type?: unknown;
      price_max_cents?: unknown;
      category?: unknown;
      description?: unknown;
      is_popular?: unknown;
      is_featured?: unknown;
      addon_timing?: unknown;
    };
    const duration = Number(row.duration_minutes) || 0;
    const buffer = Number(row.buffer_minutes) || 0;
    const totalMinutes = serviceBlockMinutes(duration, buffer);
    const priceCentsRaw = row.price_cents;
    const priceCents =
      priceCentsRaw != null && Number.isFinite(Number(priceCentsRaw))
        ? Math.round(Number(priceCentsRaw))
        : null;

    // Variable-pricing model. Legacy rows (no column) default to "fixed".
    const priceType =
      typeof row.price_type === "string" && row.price_type.trim().length > 0
        ? row.price_type.trim()
        : "fixed";
    const priceMaxRaw = row.price_max_cents;
    const priceMaxCents =
      priceMaxRaw != null && Number.isFinite(Number(priceMaxRaw))
        ? Math.round(Number(priceMaxRaw))
        : null;

    const descRaw = row.description;
    const description =
      typeof descRaw === "string" && descRaw.trim().length > 0
        ? descRaw.trim()
        : null;

    const promoData = resolveServicePromo(row.id, priceCents);
    const promoPriceDisplay = promoData.promoPriceCents != null
      ? formatServicePrice(promoData.promoPriceCents, salonCurrency, { priceType: "fixed", priceMaxCents: null })
      : null;

    return {
      id: row.id,
      name: row.name,
      durationMinutes: duration,
      bufferMinutes: buffer,
      totalMinutes,
      priceCents,
      priceType,
      priceMaxCents,
      priceDisplay: formatServicePrice(priceCents, salonCurrency, {
        priceType,
        priceMaxCents,
      }),
      category: parseServiceCategory(row.category),
      description,
      isPopular: row.is_popular === true,
      isFeatured: row.is_featured === true,
      addonConcurrent: row.addon_timing === "concurrent",
      promoPriceCents: promoData.promoPriceCents,
      promoPriceDisplay,
      promoId: promoData.promoId,
      promoName: promoData.promoName,
    };
  };

  const allRows = rows ?? [];
  const isAddonRow = (r: unknown) =>
    (r as { is_addon?: unknown }).is_addon === true;

  const staff: BookingStaffItem[] = (staffList ?? []).map((s) => ({
    id: String(s.id),
    name: String(s.name ?? ""),
    job_role: String(s.job_role ?? ""),
  }));

  let capabilityRows: { staff_id: string; service_id: string }[] | null = null;
  if (staff.length > 0) {
    const { data: capRows, error: capErr } = await client
      .from("staff_services")
      .select("staff_id, service_id")
      .in("staff_id", staff.map((s) => s.id));

    if (capErr) {
      console.error("loadBookingServices staff_services error:", capErr);
    } else if ((capRows?.length ?? 0) > 0) {
      capabilityRows = (capRows ?? []).map((r) => ({
        staff_id: String(r.staff_id),
        service_id: String(r.service_id),
      }));
    }
  }

  // Load active promotions + per-service rules for this salon in one pass.
  // Uses the public RLS policy (active = true AND now() BETWEEN starts_at AND ends_at).
  const now = new Date().toISOString();
  const { data: activePromos } = await client
    .from("promotions" as never)
    .select("id, name, discount_type, discount_value, applies_to, days_of_week, time_start, time_end")
    .eq("salon_id" as never, salonId)
    .eq("active" as never, true)
    .lte("starts_at" as never, now)
    .gte("ends_at" as never, now);

  // Assign the real data now that the DB queries have resolved.
  promoList = (activePromos ?? []) as PromoListItem[];

  if (promoList.length > 0) {
    const { data: rules } = await client
      .from("promotion_services" as never)
      .select("promotion_id, service_id, discount_type, discount_value")
      .in("promotion_id" as never, promoList.map((p) => p.id));
    promoSvcRules = (rules ?? []) as PromoSvcRuleItem[];
  }

  // Split add-ons out of the main service list: add-ons are offered only as
  // upsells on the review step, never as a primary bookable service.
  const services: BookingServiceItem[] = allRows
    .filter((r) => !isAddonRow(r))
    .map(mapServiceRow);
  const addOns: BookingServiceItem[] = allRows
    .filter(isAddonRow)
    .map(mapServiceRow)
    // Highest-value first so the most profitable upsells lead.
    .sort((a, b) => (b.priceCents ?? 0) - (a.priceCents ?? 0));

  const { data: comboRows } = await client
    .from("service_combos" as never)
    .select("id, name, description, service_ids, price_cents, discount_cents, duration_minutes")
    .eq("salon_id", salonId)
    .eq("is_active", true)
    .order("position", { ascending: true });

  const combos: BookingComboItem[] = (
    (comboRows ?? []) as {
      id: string;
      name: string;
      description?: string | null;
      service_ids?: string[];
      price_cents?: number;
      discount_cents?: number;
      duration_minutes?: number;
    }[]
  ).map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description ?? null,
    serviceIds: Array.isArray(c.service_ids) ? c.service_ids.map(String) : [],
    priceCents: Number(c.price_cents) || 0,
    discountCents: Number(c.discount_cents) || 0,
    durationMinutes: Number(c.duration_minutes) || 60,
  }));

  const salonResourcesEnabled =
    (salon as { resources_enabled?: unknown }).resources_enabled === true;
  let resources: { id: string; name: string; displayOrder: number }[] = [];
  if (salonResourcesEnabled) {
    const { data: rRows } = await client
      .from("salon_resources" as never)
      .select("id, name, display_order")
      .eq("salon_id" as never, salonId)
      .eq("status" as never, "active")
      .is("deleted_at" as never, null)
      .order("display_order" as never, { ascending: true });
    resources = ((rRows ?? []) as { id: string; name: string; display_order: number }[]).map(
      (r) => ({ id: r.id, name: r.name, displayOrder: r.display_order }),
    );
  }

  return {
    canonicalSlug,
    services,
    addOns,
    combos,
    staff,
    capabilityRows,
    resources,
    salon: {
      id: salonId,
      name: String((salon as { name?: string }).name ?? ""),
      opening_hours: (salon as { opening_hours?: unknown }).opening_hours ?? null,
      booking_closed_dates:
        (salon as { booking_closed_dates?: unknown }).booking_closed_dates ??
        null,
      acceptingBookings: !!(salon as { profile_complete?: unknown })
        .profile_complete,
      /** Only `salon_phone`; do not fall back to `phone` (owner / private). */
      salonPhone: (() => {
        const p = (salon as { salon_phone?: unknown }).salon_phone;
        const s = typeof p === "string" ? p.trim() : "";
        return s.length > 0 ? s : null;
      })(),
      privacyUrl: (() => {
        const v = (salon as { privacy_url?: unknown }).privacy_url;
        const s = typeof v === "string" ? v.trim() : "";
        return s.length > 0 ? s : null;
      })(),
      termsUrl: (() => {
        const v = (salon as { terms_url?: unknown }).terms_url;
        const s = typeof v === "string" ? v.trim() : "";
        return s.length > 0 ? s : null;
      })(),
      defaultLanguage: (() => {
        const v = (salon as { default_language?: unknown }).default_language;
        return v === "en" || v === "vi" ? v : null;
      })(),
      logoUrl: (() => {
        const v = (salon as { logo_url?: unknown }).logo_url;
        const s = typeof v === "string" ? v.trim() : "";
        return s.length > 0 ? s : null;
      })(),
      // Task #04-C — `salons.timezone` is NOT NULL after migration
      // 20260512600000_timezone_required. The legacy "UTC" fallback
      // would have silently shipped 8-hour-offset booking times for
      // BC salons; we now fall back to empty string to surface the
      // missing data to the next consumer (booking page renders
      // "salon not ready" rather than wrong times).
      timezone: (() => {
        const tz = (salon as { timezone?: unknown }).timezone;
        const s = typeof tz === "string" ? tz.trim() : "";
        return s;
      })(),
      brandColor: normalizeBrandColor(
        (salon as { brand_color?: unknown }).brand_color,
      ),
      themeMode:
        (salon as { theme_mode?: unknown }).theme_mode === "light"
          ? "light"
          : "dark",
      currencyCode: salonCurrency,
      address: (() => {
        const a = (salon as { address?: unknown }).address;
        const s = typeof a === "string" ? a.trim() : "";
        return s.length > 0 ? s : null;
      })(),
      description: (() => {
        // `description` column added by migration 20260512100000. Cast
        // path tolerates a DB still on the prior schema by returning
        // null, so this never crashes a salon that hasn't migrated.
        const d = (salon as { description?: unknown }).description;
        const s = typeof d === "string" ? d.trim() : "";
        return s.length > 0 ? s : null;
      })(),
      phoneOtpEnabled:
        (salon as { phone_otp_enabled?: unknown }).phone_otp_enabled === true,
      voiceAiEnabled:
        (salon as { voice_ai_enabled?: unknown }).voice_ai_enabled === true,
      // Release flag `group_booking` (PR2). Resolved server-side from the
      // salon's flags (getSalonBySlug uses select("*"), so the gating fields
      // are present). Beta → default OFF unless SuperAdmin enables the flag.
      groupBookingEnabled: isReleaseFeatureEnabled(
        salon as {
          subscription_plan?: string | null;
          plan_override?: string | null;
          feature_flags?: unknown;
          voice_ai_enabled?: boolean | null;
        },
        "group_booking",
      ),
      // `salons.vertical` added by migration 20260604120000. Cast-tolerant:
      // a row on the prior schema returns undefined → "nail_salon".
      vertical:
        (typeof (salon as { vertical?: unknown }).vertical === "string"
          ? ((salon as { vertical?: string }).vertical as string).trim()
          : "") || "nail_salon",
      // `salons.public_sections_enabled` added by migration 20260604160000.
      // Cast-tolerant: a row on the prior schema returns undefined → false.
      publicSectionsEnabled:
        (salon as { public_sections_enabled?: unknown }).public_sections_enabled === true,
      // `salons.booking_images` added by migration 20260605120000. Use only
      // when it carries all three string URLs; otherwise null → vertical default.
      bookingImages: (() => {
        const bi = (salon as { booking_images?: unknown }).booking_images;
        if (bi && typeof bi === "object") {
          const o = bi as { hero?: unknown; thumbA?: unknown; thumbB?: unknown };
          if (
            typeof o.hero === "string" &&
            typeof o.thumbA === "string" &&
            typeof o.thumbB === "string"
          ) {
            return { hero: o.hero, thumbA: o.thumbA, thumbB: o.thumbB };
          }
        }
        return null;
      })(),
      // `salons.staff_selection_enabled` added by migration 20260605160000.
      // Default true (only false disables the staff step).
      staffSelectionEnabled:
        (salon as { staff_selection_enabled?: unknown }).staff_selection_enabled !== false,
      // `salons.booking_lead_minutes` (migration 20260607…). Default 15.
      bookingLeadMinutes: (() => {
        const v = Number(
          (salon as { booking_lead_minutes?: unknown }).booking_lead_minutes,
        );
        return Number.isFinite(v) && v >= 0 ? Math.round(v) : 15;
      })(),
      // `salons.group_together_threshold_minutes` (migration 20260608130000).
      // Default 30.
      groupTogetherThresholdMin: (() => {
        const v = Number(
          (salon as { group_together_threshold_minutes?: unknown })
            .group_together_threshold_minutes,
        );
        return Number.isFinite(v) && v >= 0 ? Math.round(v) : 30;
      })(),
      // Per-salon override; NULL falls back to the vertical's default.
      referenceImageEnabled: (() => {
        const explicit = (salon as { reference_image_enabled?: unknown })
          .reference_image_enabled;
        if (explicit === true || explicit === false) return explicit;
        const vslug =
          (typeof (salon as { vertical?: unknown }).vertical === "string"
            ? ((salon as { vertical?: string }).vertical as string).trim()
            : "") || "nail_salon";
        return resolveVertical(vslug).referenceImageEnabled;
      })(),
      // `salons.health_ack_required` (migration 20260616200000). NULL/undefined →
      // null so the flow falls back to the per-vertical default.
      healthAckRequired: (() => {
        const v = (salon as { health_ack_required?: unknown }).health_ack_required;
        return typeof v === "boolean" ? v : null;
      })(),
      emailLinksEnabled: (() => {
        const v = (salon as { email_links_enabled?: unknown }).email_links_enabled;
        return typeof v === "boolean" ? v : null;
      })(),
      resourcesEnabled: salonResourcesEnabled,
      taxLines: (() => {
        const raw = (salon as { tax_lines?: unknown }).tax_lines;
        if (!Array.isArray(raw)) return [];
        return raw
          .filter(
            (item): item is Record<string, unknown> =>
              item !== null && typeof item === "object",
          )
          .map((item) => ({
            name: typeof item.name === "string" ? item.name : "",
            rate: typeof item.rate === "number" ? item.rate : 0,
            enabled: item.enabled !== false,
          }))
          .filter((l) => l.name.length > 0);
      })(),
    },
  };
}
