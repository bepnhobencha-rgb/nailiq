import "server-only";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { createReactivationCampaignDraft } from "@/shared/ai/createReactivationCampaignDraft";
import {
  collectUnreachablePhones,
  selectWinbackCandidates,
  WINBACK_UNREACHABLE_BACKOFF_DAYS,
  type WinbackCandidate,
} from "@/shared/winback/winbackCandidateSelection";

/**
 * AI Win-back candidate helpers plus the dashboard-only proposal runner.
 * The runner never reads recipients, calls a provider, or sends a message.
 * Audience selection happens only after first owner approval through the
 * consent-aware immutable campaign-manifest path.
 */

const str = (v: unknown): string => (v == null ? "" : String(v));

export type { WinbackCandidate };

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

  const phones = [...new Set(rows.map((r) => str(r.client_phone)).filter(Boolean))];

  // Exclude phones suggested in the last 30 days (don't pester).
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  // Exclude phones already found unreachable inside the backoff window, so an
  // uncontactable customer is not re-evaluated and re-logged on every run.
  const backoffSince = new Date(
    Date.now() - WINBACK_UNREACHABLE_BACKOFF_DAYS * 864e5,
  ).toISOString();

  const [recentRes, skippedRes, profileRes] = await Promise.all([
    db
      .from("winback_suggestions")
      .select("client_phone")
      .eq("salon_id", salonId)
      .gte("created_at", since),
    db
      .from("ai_actions_log")
      .select("payload")
      .eq("salon_id", salonId)
      .eq("agent", "winback")
      .eq("action_type", "skipped_no_channel")
      .gte("created_at", backoffSince),
    // Second source for the address: the RPC only reads bookings.client_email.
    phones.length
      ? db.from("client_profiles").select("phone, email").in("phone", phones)
      : Promise.resolve({ data: [] as Row[] }),
  ]);

  const suggested = new Set(
    ((recentRes.data ?? []) as Row[]).map((r) => str(r.client_phone)),
  );
  const unreachable = collectUnreachablePhones(
    (skippedRes.data ?? []) as Array<{ payload?: unknown }>,
  );
  const profileEmailByPhone = new Map<string, string>();
  for (const r of (profileRes.data ?? []) as Row[]) {
    const phone = str(r.phone);
    const email = str(r.email).trim();
    if (phone && email && !profileEmailByPhone.has(phone)) {
      profileEmailByPhone.set(phone, email);
    }
  }

  return selectWinbackCandidates(rows, {
    suggestedPhones: suggested,
    unreachablePhones: unreachable,
    profileEmailByPhone,
    limit,
  });
}

/**
 * Create one PII-free dashboard draft per salon/week. The `cap` argument is
 * retained for call-site compatibility but is intentionally unused: audience
 * size is calculated later by the separate dry-run manifest gate.
 */
export async function runWinback(salonId: string, _cap = 3): Promise<void> {
  try {
    void _cap;
    const db = looseServiceClient();
    const { data: salon } = await db
      .from("salons")
      .select("name, feature_flags" as never)
      .eq("id", salonId)
      .maybeSingle();
    const s = (salon as Row | null) ?? {};
    if ((s.feature_flags as Record<string, unknown> | null)?.ai_winback !== true) return;
    const outcome = await createReactivationCampaignDraft({
      salonId,
      salonName: str(s.name) || "our salon",
      kind: "winback",
    });
    if (outcome === "failed") throw new Error("winback_draft_failed");
  } catch (e) {
    console.error("[runWinback]", e);
    throw e;
  }
}
