import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type SalonVoiceContext = {
  salonId:         string;
  salonName:       string;
  timezone:        string;
  address:         string | null;
  personaName:     string;
  personaVoice:    string;
  reasoningEffort: string;
  businessHours:   unknown;
  services: {
    id:           string;
    name:         string;
    durationMins: number;
    priceCents:   number;
  }[];
  staff: {
    id:   string;
    name: string;
  }[];
};

export async function loadSalonContext(salonSlug: string): Promise<SalonVoiceContext | null> {
  const supabase = createServiceRoleClient();

  const { data: salon } = await supabase
    .from("salons")
    .select("id, name, timezone, address, hours, voice_ai_persona_name, voice_ai_persona_voice, voice_ai_reasoning_effort")
    .eq("slug", salonSlug)
    .single();

  if (!salon) return null;

  // voice_ai columns are added by migration — cast to any until types are regenerated
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = salon as any;

  const [{ data: services }, { data: staff }] = await Promise.all([
    supabase
      .from("services")
      .select("id, name, duration_minutes, price_cents")
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
    personaName:     s.voice_ai_persona_name      ?? "Lily",
    personaVoice:    s.voice_ai_persona_voice      ?? "marin",
    reasoningEffort: s.voice_ai_reasoning_effort   ?? "low",
    businessHours:   salon.hours,
    services: (services ?? []).map((svc) => ({
      id:           svc.id,
      name:         svc.name,
      durationMins: svc.duration_minutes,
      priceCents:   svc.price_cents,
    })),
    staff: (staff ?? []).map((m) => ({ id: m.id, name: m.name })),
  };
}
