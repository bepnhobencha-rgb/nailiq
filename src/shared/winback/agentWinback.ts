import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * AI Win-back — find lapsed regulars and draft a warm, personalised "we miss
 * you" message for the owner to review (and later send). Same spine as the other
 * agents: gather (DB, salon-scoped via the winback_candidates RPC) → AI drafts →
 * guard → log to winback_suggestions. The AI only SUGGESTS; sending stays
 * owner-decided, so a wrong draft costs nothing.
 */

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => (v == null ? 0 : Number(v));

export type WinbackCandidate = {
  phone: string;
  name: string;
  email: string | null;
  visits: number;
  lastVisit: string;
  noShows: number;
};

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!client) client = new Anthropic({ apiKey: key });
  return client;
}

/** Lapsed regulars not already suggested in the last 30 days. */
export async function gatherWinbackCandidates(
  salonId: string,
  limit: number,
): Promise<WinbackCandidate[]> {
  const db = looseServiceClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (db as any).rpc("winback_candidates", {
    p_salon_id: salonId,
    p_min_visits: 2,
    p_lapse_days: 45,
    p_max_days: 365,
    p_limit: limit * 4, // over-fetch; we filter out recently-suggested below
  });
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return [];

  // Exclude phones suggested in the last 30 days (don't pester).
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const { data: recent } = await db
    .from("winback_suggestions")
    .select("client_phone")
    .eq("salon_id", salonId)
    .gte("created_at", since);
  const suggested = new Set(((recent ?? []) as Row[]).map((r) => str(r.client_phone)));

  const out: WinbackCandidate[] = [];
  for (const r of rows) {
    const phone = str(r.client_phone);
    if (suggested.has(phone)) continue;
    out.push({
      phone,
      name: str(r.client_name) || "there",
      email: str(r.client_email) || null,
      visits: num(r.visits),
      lastVisit: str(r.last_visit),
      noShows: num(r.no_shows),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** ① AI BRAIN — draft a warm win-back message. Returns null on failure. */
export async function agentDraftWinback(
  c: WinbackCandidate,
  salonName: string,
  lang: "en" | "vi",
): Promise<string | null> {
  const ai = getClient();
  if (!ai) return null;

  const weeks = Math.max(1, Math.round((Date.now() - Date.parse(c.lastVisit)) / (7 * 864e5)));
  const langLabel = lang === "vi" ? "tiếng Việt" : "English";
  const prompt = `Write a short, warm, genuine win-back message in ${langLabel} for a salon customer who hasn't been in for a while. Make them feel remembered, not sold to.

Customer: ${c.name}, visited ${c.visits} times before, last visit about ${weeks} weeks ago.
Salon: ${salonName}.

Rules: 1-2 sentences, friendly + personal, mention the salon by name, gently invite them to come back, NO emojis, NO links (those are added when sent). Return ONLY the message text, nothing else.`;

  try {
    const resp = await ai.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    const clean = text.replace(/^["']|["']$/g, "").trim();
    return clean.length > 0 && clean.length <= 480 ? clean : null;
  } catch {
    return null;
  }
}

/**
 * Run win-back for one salon: opt-in (feature_flags.ai_winback), drafts up to
 * `cap` fresh suggestions per call. Cheap to call every cron — the 30-day dedupe
 * means it goes quiet once the lapsed list is covered. Best-effort.
 */
export async function runWinback(salonId: string, cap = 3): Promise<void> {
  try {
    const db = looseServiceClient();
    const { data: salon } = await db
      .from("salons")
      .select("name, feature_flags")
      .eq("id", salonId)
      .maybeSingle();
    const s = (salon as Row | null) ?? {};
    if ((s.feature_flags as Record<string, unknown> | null)?.ai_winback !== true) return;
    const salonName = str(s.name) || "our salon";

    const candidates = await gatherWinbackCandidates(salonId, cap);
    if (candidates.length === 0) return;

    const svc = createServiceRoleClient();
    for (const c of candidates) {
      const lang: "en" | "vi" = "en"; // North-American salons; refine per-salon later
      const message = await agentDraftWinback(c, salonName, lang);
      if (!message) continue;
      await svc.from("winback_suggestions" as never).insert({
        salon_id: salonId,
        client_phone: c.phone,
        client_name: c.name,
        client_email: c.email,
        last_visit: c.lastVisit,
        visit_count: c.visits,
        lang,
        channel: c.email ? "email" : "sms",
        message,
        status: "suggested",
      } as never);
    }
  } catch (e) {
    console.error("[runWinback]", e);
  }
}
