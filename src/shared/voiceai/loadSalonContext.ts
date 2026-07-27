import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  normalizeAllowedLanguages,
  type SupportedLanguage,
} from "@/shared/voiceai/config";

export type SalonVoiceContext = {
  salonId:         string;
  salonName:       string;
  timezone:        string;
  address:         string | null;
  /** Salon currency_code (CAD | USD | VND); used to format service prices. */
  currency:        string | null;
  personaName:     string;
  personaVoice:    string;
  reasoningEffort: string;
  /** Languages the salon allows the phone receptionist to speak. */
  allowedLanguages: SupportedLanguage[];
  /** When true, the receptionist offers ONE tasteful upsell after a service is
   *  chosen. salons.voice_ai_upsell_enabled (default true). */
  upsellEnabled:   boolean;
  businessHours:   unknown;
  services: {
    id:              string;
    name:            string;
    durationMins:    number;
    priceCents:      number;
    // Variable pricing model — matches services.price_type / price_max_cents.
    price_type:      string;
    price_max_cents: number | null;
    /** Salon-authored facts shown on the booking page and used by the voice
     * receptionist for inclusions and eligibility. Null means "not confirmed",
     * never permission for the model to infer an answer. */
    description:      string | null;
    // Upsell hints — the salon can flag which services to push; the agent honours
    // them and otherwise suggests a sensible upgrade/combo from the same menu.
    category:        string | null;
    isAddon:         boolean;
    isPopular:       boolean;
    isFeatured:      boolean;
  }[];
  staff: {
    id:   string;
    name: string;
  }[];
};

// ── In-memory TTL cache ──────────────────────────────────────────────────────
// Session mint is on the critical path of call-connect latency: every voice
// session paid 3 sequential DB round-trips before the customer heard anything.
// Salon config (services/staff/hours) changes rarely, so a short per-instance
// cache removes that cost for warm instances. 60 s TTL keeps dashboard edits
// visible almost immediately; serverless instances are short-lived anyway.
const CONTEXT_CACHE_TTL_MS = 60_000;
const contextCache = new Map<string, { at: number; ctx: SalonVoiceContext }>();

export async function loadSalonContext(salonSlug: string): Promise<SalonVoiceContext | null> {
  const cached = contextCache.get(salonSlug);
  if (cached && Date.now() - cached.at < CONTEXT_CACHE_TTL_MS) {
    return cached.ctx;
  }

  const ctx = await loadSalonContextUncached(salonSlug);
  if (ctx) contextCache.set(salonSlug, { at: Date.now(), ctx });
  return ctx;
}

async function loadSalonContextUncached(salonSlug: string): Promise<SalonVoiceContext | null> {
  const supabase = createServiceRoleClient();

  const { data: salon } = await supabase
    .from("salons")
    .select("id, name, timezone, address, currency_code, opening_hours, voice_ai_persona_name, voice_ai_persona_voice, voice_ai_reasoning_effort, voice_ai_upsell_enabled, voice_ai_allowed_languages")
    .eq("slug", salonSlug)
    .single();

  if (!salon) return null;

  // voice_ai columns are added by migration — cast to any until types are regenerated
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = salon as any;

  const [{ data: services }, { data: staff }] = await Promise.all([
    supabase
      .from("services")
      .select("id, name, duration_minutes, price_cents, price_type, price_max_cents, description, category, is_addon, is_popular, is_featured")
      .eq("salon_id", salon.id)
      .is("deleted_at", null)
      .order("name"),
    supabase
      .from("staff")
      .select("id, name")
      .eq("salon_id", salon.id)
      .eq("status", "active")
      .is("deleted_at", null)
      .order("name"),
  ]);

  return {
    salonId:         salon.id,
    salonName:       salon.name,
    timezone:        salon.timezone ?? "America/Vancouver",
    address:         salon.address ?? null,
    currency:        salon.currency_code ?? null,
    personaName:     s.voice_ai_persona_name      ?? "Lily",
    personaVoice:    s.voice_ai_persona_voice      ?? "marin",
    reasoningEffort: s.voice_ai_reasoning_effort   ?? "low",
    allowedLanguages: normalizeAllowedLanguages(s.voice_ai_allowed_languages),
    upsellEnabled:   s.voice_ai_upsell_enabled     ?? true,
    businessHours:   s.opening_hours,
    services: (services ?? []).map((svc) => ({
      id:              svc.id,
      name:            svc.name,
      durationMins:    svc.duration_minutes,
      priceCents:      svc.price_cents,
      price_type:      svc.price_type ?? "fixed",
      price_max_cents: svc.price_max_cents ?? null,
      description:     svc.description?.trim() || null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      category:        (svc as any).category ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isAddon:         Boolean((svc as any).is_addon),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isPopular:       Boolean((svc as any).is_popular),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isFeatured:      Boolean((svc as any).is_featured),
    })),
    staff: (staff ?? []).map((m) => ({ id: m.id, name: m.name })),
  };
}
