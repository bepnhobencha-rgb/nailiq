"use server";
import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { createTextBackgroundAnthropicClient } from "@/shared/ai/anthropicProviderPolicy";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { defaultSip } from "./defaultSip";
import type { SalonIntelligenceProfile } from "./types";
import { isProviderTimeoutError, trackAnthropicMessage } from "./usageLedger";

// ---------------------------------------------------------------------------
// Anthropic client (module-level singleton, mirrors agentWinback.ts pattern)
// ---------------------------------------------------------------------------

let _anthropic: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!_anthropic) _anthropic = createTextBackgroundAnthropicClient(key);
  return _anthropic;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type ServiceRow = { name: string; price_cents: number | null; duration_minutes: number | null };

/** Fetch the minimal salon context needed to build a SIP. */
async function fetchSalonContext(salonId: string) {
  const db = createServiceRoleClient();

  const [salonRes, servicesRes, statsRes] = await Promise.all([
    db
      .from("salons")
      .select("id, name, slug, default_language, timezone, vertical, noshow_protection_enabled")
      .eq("id", salonId)
      .single(),

    db
      .from("services")
      .select("name, price_cents, duration_minutes")
      .eq("salon_id", salonId)
      .is("deleted_at" as never, null)
      .order("name")
      .limit(40),

    // 30-day booking stats: total bookings + no-shows
    db
      .from("bookings")
      .select("status", { count: "exact", head: false })
      .eq("salon_id", salonId)
      .gte("booking_date", new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)),
  ]);

  if (salonRes.error) {
    throw new Error(`buildSip: failed to load salon ${salonId}: ${salonRes.error.message}`);
  }

  return {
    salon: salonRes.data as Record<string, unknown> | null,
    services: (servicesRes.data ?? []) as ServiceRow[],
    bookingRows: statsRes.data as { status: string }[] | null,
  };
}

/** Derive a no-show rate percentage from status rows. */
function calcNoShowRate(rows: { status: string }[] | null): number {
  if (!rows || rows.length === 0) return 0;
  const noShows = rows.filter((r) => r.status === "no_show").length;
  return Math.round((noShows / rows.length) * 100);
}

// ---------------------------------------------------------------------------
// buildSip — synthesise SalonIntelligenceProfile via Claude Sonnet
// ---------------------------------------------------------------------------

export async function buildSip(salonId: string): Promise<SalonIntelligenceProfile> {
  const db = createServiceRoleClient();
  const { salon, services, bookingRows } = await fetchSalonContext(salonId);

  if (!salon) throw new Error(`buildSip: salon ${salonId} not found`);

  const ai = getClient();
  if (!ai) {
    // No API key — persist and return a default SIP so the app stays functional
    const sip = defaultSip({
      language: salon.default_language as string | null | undefined,
    });
    sip.built_via = "settings_change";
    sip.built_at = new Date().toISOString();
    await db.from("salons").update({ ai_profile: sip }).eq("id", salonId);
    return sip;
  }

  const totalBookings = bookingRows?.length ?? 0;
  const noShowRate = calcNoShowRate(bookingRows);

  const servicesSummary =
    services.length === 0
      ? "No services configured yet."
      : services
          .slice(0, 20)
          .map((s) => {
            const price = s.price_cents != null ? `$${(s.price_cents / 100).toFixed(0)}` : "?";
            const dur = s.duration_minutes != null ? `${s.duration_minutes}min` : "";
            return `• ${s.name} ${price} ${dur}`.trim();
          })
          .join("\n");

  const prompt = `You are building a SalonIntelligenceProfile (SIP) for an AI Salon Manager.

## Salon data
- Name: ${String(salon.name ?? "")}
- Vertical: ${String(salon.vertical ?? "nail")}
- Primary language: ${String(salon.default_language ?? "en")}
- Timezone: ${String(salon.timezone ?? "America/Los_Angeles")}
- No-show protection enabled: ${String(salon.noshow_protection_enabled ?? false)}
- Bookings (last 30 days): ${totalBookings}
- No-show rate (last 30 days): ${noShowRate}%

## Services (up to 20)
${servicesSummary}

## SalonIntelligenceProfile TypeScript type
{
  vertical: "nail" | "head_spa" | "massage" | "facial" | "waxing" | "multi";
  brand_voice: "warm_casual" | "warm_professional" | "luxury_formal" | "friendly_fun";
  language_primary: "en" | "vi" | "zh" | "ko";
  language_secondary?: "en" | "vi" | "zh" | "ko";
  customer_demographic?: string;          // e.g. "working professionals 25-45"
  noshow_strictness: "lenient" | "moderate" | "strict";
  contact_window: string;                 // e.g. "9:00-20:00"
  winback_cadence: "gentle" | "normal" | "aggressive";
  primary_goal: "retain_regulars" | "attract_new" | "maximize_revenue";
  auto_approve: string[];                 // tasks AI may act on autonomously
  escalate: string[];                     // tasks that always need human review
  tone_examples: string[];                // 2-3 sample phrases matching brand voice
  built_at: string;                       // ISO timestamp — you must set this
  built_via: "manager_briefing" | "settings_change" | "weekly_eval";
}

Rules:
1. Infer vertical from services if salon.vertical is missing/generic.
2. Set noshow_strictness to "strict" if no-show rate > 15%, "lenient" if < 5%, else "moderate".
3. brand_voice: use "luxury_formal" for head_spa/facial/massage; "friendly_fun" for youth-oriented; default "warm_professional".
4. Set built_via = "settings_change".
5. Set built_at = current ISO timestamp.
6. auto_approve must include at minimum: ["send_reminders", "send_winback"].
7. escalate must include at minimum: ["charge_card", "change_price"].
8. tone_examples: write 2-3 short phrases in language_primary that match brand_voice.
9. Output ONLY valid JSON matching the type above. No markdown, no explanation.`;

  let sip: SalonIntelligenceProfile;
  try {
    const message = await trackAnthropicMessage(
      {
        salonId,
        feature: "sip_builder",
        model: "claude-sonnet-4-5",
      },
      () => ai.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
    );

    const raw = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    sip = JSON.parse(raw) as SalonIntelligenceProfile;
    // Ensure required timestamps are always set correctly
    sip.built_at = new Date().toISOString();
    sip.built_via = "settings_change";
  } catch (err) {
    if (isProviderTimeoutError(err)) throw err;
    // If Claude returns bad JSON or request fails, fall back to default
    console.warn("[buildSip] Claude parse/call error, using defaultSip:", err);
    sip = defaultSip({
      language: salon.default_language as string | null | undefined,
    });
    sip.built_via = "settings_change";
    sip.built_at = new Date().toISOString();
  }

  // Persist to DB
  await db.from("salons").update({ ai_profile: sip }).eq("id", salonId);

  return sip;
}

// ---------------------------------------------------------------------------
// rebuildSipIfStale — call from settings-change hooks
// ---------------------------------------------------------------------------

/** Rebuild the SIP if it has never been built or was built more than 7 days ago. */
export async function rebuildSipIfStale(salonId: string): Promise<void> {
  const db = createServiceRoleClient();
  const { data } = await db
    .from("salons")
    .select("ai_profile")
    .eq("id", salonId)
    .single();

  const profile = data?.ai_profile as SalonIntelligenceProfile | null | undefined;
  if (profile?.built_at) {
    const age = Date.now() - new Date(profile.built_at).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    if (age < sevenDaysMs) return; // still fresh
  }

  await buildSip(salonId);
}
