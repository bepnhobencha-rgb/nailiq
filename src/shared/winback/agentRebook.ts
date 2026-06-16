import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * AI "Due to Rebook" — the proactive sibling of win-back. Win-back chases
 * customers who are ALREADY 45+ days lapsed; this nudges on-rhythm regulars who
 * are coming DUE for their next visit (by their median cadence) but haven't
 * booked yet — the highest-value moment to reach out. AI drafts a warm "time
 * for your next <service>?" for the owner to review/send. Same spine as the
 * other agents; AI only SUGGESTS. Logs to winback_suggestions with kind='due'.
 */

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => (v == null ? 0 : Number(v));

export type RebookCandidate = {
  phone: string;
  name: string;
  email: string | null;
  visits: number;
  lastVisit: string;
  cadenceDays: number;
  predictedNext: string;
  usualService: string | null;
};

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!client) client = new Anthropic({ apiKey: key });
  return client;
}

/** On-rhythm regulars coming due, not already suggested in the last 30 days. */
export async function gatherRebookCandidates(
  salonId: string,
  limit: number,
): Promise<RebookCandidate[]> {
  const db = looseServiceClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (db as any).rpc("rebook_due_candidates", {
    p_salon_id: salonId,
    p_min_visits: 3,
    p_lookahead_days: 14,
    p_overdue_days: 30,
    p_limit: limit * 4,
  });
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return [];

  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const { data: recent } = await db
    .from("winback_suggestions")
    .select("client_phone")
    .eq("salon_id", salonId)
    .gte("created_at", since);
  const suggested = new Set(((recent ?? []) as Row[]).map((r) => str(r.client_phone)));

  const out: RebookCandidate[] = [];
  for (const r of rows) {
    const phone = str(r.client_phone);
    if (suggested.has(phone)) continue;
    out.push({
      phone,
      name: str(r.client_name) || "there",
      email: str(r.client_email) || null,
      visits: num(r.visits),
      lastVisit: str(r.last_visit),
      cadenceDays: num(r.cadence_days),
      predictedNext: str(r.predicted_next),
      usualService: str(r.usual_service) || null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** ① AI BRAIN — draft a warm "you're due" message. Returns null on failure. */
export async function agentDraftRebook(
  c: RebookCandidate,
  salonName: string,
  lang: "en" | "vi",
): Promise<string | null> {
  const ai = getClient();
  if (!ai) return null;

  const weeks = Math.max(1, Math.round(c.cadenceDays / 7));
  const langLabel = lang === "vi" ? "tiếng Việt" : "English";
  const svc = c.usualService ? `their usual "${c.usualService}"` : "their next visit";
  const prompt = `Write a short, warm, genuine message in ${langLabel} for a loyal salon regular who is about due for their next appointment but hasn't booked yet. Make it feel caring and personal, not pushy.

Customer: ${c.name}, comes in roughly every ${weeks} week(s), usually books ${svc}, at ${salonName}.

Rules: 1-2 sentences, friendly + personal, mention the salon by name, gently offer to save them a spot for their next visit, NO emojis, NO links (added when sent). Return ONLY the message text.`;

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
 * Run "due to rebook" for one salon: opt-in (feature_flags.ai_rebook), drafts up
 * to `cap` fresh suggestions per call (kind='due'). 30-day dedupe shared with
 * win-back so a customer isn't pestered by both. Best-effort.
 */
export async function runRebook(salonId: string, cap = 3): Promise<void> {
  try {
    const db = looseServiceClient();
    const { data: salon } = await db
      .from("salons")
      .select("name, feature_flags")
      .eq("id", salonId)
      .maybeSingle();
    const s = (salon as Row | null) ?? {};
    if ((s.feature_flags as Record<string, unknown> | null)?.ai_rebook !== true) return;
    const salonName = str(s.name) || "our salon";

    const candidates = await gatherRebookCandidates(salonId, cap);
    if (candidates.length === 0) return;

    const svc = createServiceRoleClient();
    for (const c of candidates) {
      const lang: "en" | "vi" = "en";
      const message = await agentDraftRebook(c, salonName, lang);
      if (!message) continue;
      await svc.from("winback_suggestions" as never).insert({
        salon_id: salonId,
        kind: "due",
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
    console.error("[runRebook]", e);
  }
}
