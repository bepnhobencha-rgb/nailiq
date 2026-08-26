import "server-only";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { createReactivationCampaignDraft } from "@/shared/ai/createReactivationCampaignDraft";

/**
 * Rebook candidate helper plus the dashboard-only proposal runner. The runner
 * never reads recipients, calls a provider, or sends a message.
 */

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const errorCode = (error: unknown): string => {
  if (!error || typeof error !== "object" || !("code" in error)) return "unknown";
  return str(error.code) || "unknown";
};

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

/** On-rhythm regulars coming due, not already suggested in the last 30 days. */
export async function gatherRebookCandidates(
  salonId: string,
  limit: number,
): Promise<RebookCandidate[]> {
  const db = looseServiceClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any).rpc("rebook_due_candidates", {
    p_salon_id: salonId,
    p_min_visits: 3,
    p_lookahead_days: 14,
    p_overdue_days: 30,
    p_limit: limit * 4,
  });
  if (error) {
    throw new Error(
      `rebook candidates query failed [${errorCode(error)}]: ${str(error.message) || "database error"}`,
    );
  }
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return [];

  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const { data: recent, error: recentError } = await db
    .from("winback_suggestions")
    .select("client_phone")
    .eq("salon_id", salonId)
    .gte("created_at", since);
  if (recentError) {
    throw new Error(
      `rebook dedupe query failed [${errorCode(recentError)}]: ${str(recentError.message) || "database error"}`,
    );
  }
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

/**
 * Create one PII-free dashboard draft per salon/week. The `cap` argument is
 * retained for call-site compatibility but intentionally unused.
 */
export async function runRebook(salonId: string, _cap = 3): Promise<void> {
  try {
    void _cap;
    const db = looseServiceClient();
    const { data: salon } = await db
      .from("salons")
      .select("name, feature_flags" as never)
      .eq("id", salonId)
      .maybeSingle();
    const s = (salon as Row | null) ?? {};
    if ((s.feature_flags as Record<string, unknown> | null)?.ai_rebook !== true) return;
    const outcome = await createReactivationCampaignDraft({
      salonId,
      salonName: str(s.name) || "our salon",
      kind: "rebook",
    });
    if (outcome === "failed") throw new Error("rebook_draft_failed");
  } catch (e) {
    console.error("[runRebook]", e);
    throw e;
  }
}
