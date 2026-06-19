import "server-only";
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
