import "server-only";
import { unstable_cache } from "next/cache";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type MinhLesson = {
  id: string;
  salonId: string | null;
  scope: string;
  condition: Record<string, unknown>;
  rule: string;
  source: string;
  confidence: number;
};

/**
 * Load active lessons for a scope, combining global (salon_id=null) and
 * per-salon lessons. Returns highest-confidence first.
 * Cached 5min with tag `minh_lessons:${salonId}`.
 */
export async function getLessons(
  salonId: string,
  scope: string,
): Promise<MinhLesson[]> {
  const fetcher = async () => {
    const db = createServiceRoleClient();
    const { data, error } = await db
      .from("minh_lessons" as never)
      .select("id, salon_id, scope, condition, rule, source, confidence" as never)
      .eq("scope" as never, scope)
      .eq("active" as never, true)
      .or(`salon_id.is.null,salon_id.eq.${salonId}` as never)
      .order("confidence" as never, { ascending: false });
    if (error) {
      console.error("[getLessons]", error);
      return [] as MinhLesson[];
    }
    return ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      salonId: (r.salon_id as string | null) ?? null,
      scope: r.scope as string,
      condition: (r.condition as Record<string, unknown>) ?? {},
      rule: r.rule as string,
      source: r.source as string,
      confidence: Number(r.confidence ?? 0),
    }));
  };

  // Cache per salon+scope, 5 min
  const cached = unstable_cache(fetcher, [`minh_lessons_${salonId}_${scope}`], {
    tags: [`minh_lessons:${salonId}`, "minh_lessons:global"],
    revalidate: 300,
  });
  return cached();
}

/**
 * Check if a channel+scope lesson blocks SMS for a US/A2P scenario.
 * Agents call this to respect lesson #1 even after the code guardrail
 * might be removed. Returns the blocking lesson or null.
 */
export function findChannelLesson(
  lessons: MinhLesson[],
  context: { country: string; a2pRegistered: boolean },
): MinhLesson | null {
  for (const l of lessons) {
    if (l.scope !== "channel") continue;
    const cond = l.condition;
    const matchCountry = !cond.country || cond.country === context.country;
    const matchA2p =
      !("a2p_registered" in cond) ||
      Boolean(cond.a2p_registered) === context.a2pRegistered;
    if (matchCountry && matchA2p && l.rule.startsWith("prefer_email")) return l;
  }
  return null;
}

const CAP_MULTIPLIER_PREFIX = "cap_multiplier:";

/**
 * Apply the most conservative active outcome lesson for one agent.
 *
 * Learned caps may only reduce an existing code cap, never raise it or pause an
 * agent completely. That keeps outcome adaptation inside the already-approved
 * operational envelope while avoiding a single noisy sample shutting work off.
 */
export function applyLearnedAgentCap(
  baseCap: number,
  lessons: MinhLesson[],
  agent: string,
): number {
  const safeBase = Math.max(1, Math.floor(baseCap));
  let multiplier = 1;

  for (const lesson of lessons) {
    if (lesson.scope !== "segment" || lesson.condition.agent !== agent) continue;
    if (!lesson.rule.startsWith(CAP_MULTIPLIER_PREFIX)) continue;
    const parsed = Number(lesson.rule.slice(CAP_MULTIPLIER_PREFIX.length));
    if (!Number.isFinite(parsed)) continue;
    // Automatic adaptation is deliberately bounded to 25-100% of the cap.
    multiplier = Math.min(multiplier, Math.max(0.25, Math.min(1, parsed)));
  }

  return Math.max(1, Math.floor(safeBase * multiplier));
}
