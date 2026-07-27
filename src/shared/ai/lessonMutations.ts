import "server-only";
import { createHash } from "node:crypto";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const DEACTIVATE_THRESHOLD = 0.2; // lessons below this confidence are deactivated

/**
 * Reduce confidence of an active lesson by delta (default 0.1).
 * Automatically deactivates the lesson if confidence falls below threshold.
 */
export async function decreaseLessonConfidence(
  lessonId: string,
  delta = 0.1,
): Promise<void> {
  const db = createServiceRoleClient();

  // Fetch current confidence
  const { data: lesson, error: fetchErr } = await db
    .from("minh_lessons" as never)
    .select("confidence")
    .eq("id" as never, lessonId)
    .eq("active" as never, true)
    .maybeSingle();

  if (fetchErr || !lesson) {
    console.error("[decreaseLessonConfidence] fetch", lessonId, fetchErr);
    return;
  }

  const currentConfidence = Number(
    (lesson as { confidence: number }).confidence ?? 0,
  );
  const newConfidence = Math.max(0, currentConfidence - delta);

  if (newConfidence < DEACTIVATE_THRESHOLD) {
    await deactivateLesson(
      lessonId,
      `confidence fell to ${newConfidence.toFixed(2)} (threshold ${DEACTIVATE_THRESHOLD})`,
    );
    return;
  }

  const { error } = await db
    .from("minh_lessons" as never)
    .update({ confidence: newConfidence } as never)
    .eq("id" as never, lessonId);

  if (error) {
    console.error("[decreaseLessonConfidence] update", lessonId, error);
  }
}

/**
 * Deactivate a lesson (mark active=false). Lessons are never deleted —
 * audit trail is preserved. Reason is appended to source field.
 */
export async function deactivateLesson(
  lessonId: string,
  reason: string,
): Promise<void> {
  const db = createServiceRoleClient();

  // Append deactivation reason to source for audit trail
  const { data: lesson } = await db
    .from("minh_lessons" as never)
    .select("source")
    .eq("id" as never, lessonId)
    .maybeSingle();

  const oldSource = (lesson as { source?: string } | null)?.source ?? "";
  const updatedSource = `${oldSource} | deactivated: ${reason}`.slice(0, 500);

  const { error } = await db
    .from("minh_lessons" as never)
    .update({ active: false, source: updatedSource } as never)
    .eq("id" as never, lessonId);

  if (error) {
    console.error("[deactivateLesson]", lessonId, error);
  }
}

/**
 * Create a new lesson from an observed pattern.
 * Returns the new lesson id, or null if the insert failed.
 */
export async function createLesson(params: {
  salonId: string | null;
  scope: string;
  condition: Record<string, unknown>;
  rule: string;
  source: string;
  confidence?: number;
}): Promise<string | null> {
  const db = createServiceRoleClient();

  const { data, error } = await db
    .from("minh_lessons" as never)
    .insert({
      salon_id: params.salonId,
      scope: params.scope,
      condition: params.condition,
      rule: params.rule,
      source: params.source,
      confidence: params.confidence ?? 0.7,
      active: true,
    } as never)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[createLesson]", error);
    return null;
  }

  return (data as { id: string } | null)?.id ?? null;
}

const OUTCOME_SOURCE_PREFIX = "outcome_adaptation:";

function outcomeAdaptationId(salonId: string, agent: string): string {
  const hex = createHash("sha256")
    .update(`nailiq:outcome-adaptation:${salonId}:${agent}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type OutcomeAdaptationMutation = {
  lessonId: string | null;
  changed: boolean;
  active: boolean;
};

/**
 * Idempotently activates or recovers the one learned cap for an agent/salon.
 * Source is a stable machine key so daily analysis updates rather than inserts
 * duplicate lessons.
 */
export async function setOutcomeAdaptation(params: {
  salonId: string;
  agent: string;
  active: boolean;
  capMultiplier?: number;
}): Promise<OutcomeAdaptationMutation> {
  const db = createServiceRoleClient();
  const source = `${OUTCOME_SOURCE_PREFIX}${params.agent}`;
  const rule = `cap_multiplier:${Math.max(
    0.25,
    Math.min(1, params.capMultiplier ?? 0.5),
  )}`;
  const condition = { agent: params.agent };

  const { data: existingData, error: fetchError } = await db
    .from("minh_lessons" as never)
    .select("id, active, rule, condition")
    .eq("salon_id" as never, params.salonId)
    .eq("scope" as never, "segment")
    .eq("source" as never, source)
    .order("created_at" as never, { ascending: false })
    .limit(1)
    .maybeSingle();
  if (fetchError) {
    console.error("[setOutcomeAdaptation] fetch", fetchError);
    return { lessonId: null, changed: false, active: params.active };
  }

  const existing = existingData as
    | {
        id: string;
        active: boolean;
        rule: string;
        condition: Record<string, unknown>;
      }
    | null;

  if (!existing) {
    if (!params.active) {
      return { lessonId: null, changed: false, active: false };
    }
    const { data, error } = await db
      .from("minh_lessons" as never)
      .upsert({
        id: outcomeAdaptationId(params.salonId, params.agent),
        salon_id: params.salonId,
        scope: "segment",
        condition,
        rule,
        source,
        confidence: 0.7,
        active: true,
      } as never, { onConflict: "id" })
      .select("id")
      .maybeSingle();
    if (error) {
      console.error("[setOutcomeAdaptation] insert", error);
      return { lessonId: null, changed: false, active: true };
    }
    return {
      lessonId: (data as { id: string } | null)?.id ?? null,
      changed: true,
      active: true,
    };
  }

  const sameAgent = existing.condition?.agent === params.agent;
  const desiredRule = params.active ? rule : existing.rule;
  const changed =
    existing.active !== params.active ||
    (params.active && (!sameAgent || existing.rule !== desiredRule));
  if (!changed) {
    return {
      lessonId: existing.id,
      changed: false,
      active: params.active,
    };
  }

  const patch = {
    active: params.active,
    condition,
    rule: desiredRule,
    updated_at: new Date().toISOString(),
    ...(params.active ? { confidence: 0.7 } : {}),
  };
  const { error } = await db
    .from("minh_lessons" as never)
    .update(patch as never)
    .eq("id" as never, existing.id)
    .eq("salon_id" as never, params.salonId);
  if (error) {
    console.error("[setOutcomeAdaptation] update", error);
    return {
      lessonId: existing.id,
      changed: false,
      active: params.active,
    };
  }

  return {
    lessonId: existing.id,
    changed: true,
    active: params.active,
  };
}
