"use server";

import { revalidatePath } from "next/cache";
import {
  allGoLivePrerequisitesConfirmed,
  GO_LIVE_ATTESTATION_KEYS,
  type GoLiveAttestationAction,
  type GoLiveAttestationKey,
} from "@/shared/dashboard/goLiveAttestations";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { loadGoLiveReadiness } from "@/shared/dashboard/loadGoLiveReadiness";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type RecordGoLiveAttestationResult =
  | { ok: true; unchanged?: boolean }
  | {
      ok: false;
      reason:
        | "unauthorized"
        | "invalid_input"
        | "technical_gates_incomplete"
        | "prerequisites_incomplete"
        | "unavailable";
    };

export async function recordGoLiveAttestation(
  slug: string,
  input: {
    checkKey: GoLiveAttestationKey;
    action: GoLiveAttestationAction;
    evidenceNote: string;
  },
): Promise<RecordGoLiveAttestationResult> {
  if (
    typeof slug !== "string" ||
    !slug.trim() ||
    !input ||
    typeof input !== "object" ||
    !GO_LIVE_ATTESTATION_KEYS.includes(
      (input as { checkKey?: unknown }).checkKey as GoLiveAttestationKey,
    ) ||
    (input.action !== "attest" && input.action !== "revoke") ||
    typeof input.evidenceNote !== "string"
  ) {
    return { ok: false, reason: "invalid_input" };
  }
  const note = input.evidenceNote.trim();
  if (note.length < 10 || note.length > 500) {
    return { ok: false, reason: "invalid_input" };
  }

  const ctx = await getDashboardWriteClient(slug);
  if (
    !ctx ||
    ctx.kind !== "member" ||
    !ctx.userId ||
    !isOwnerOrAdmin(ctx.role)
  ) {
    return { ok: false, reason: "unauthorized" };
  }
  if (input.checkKey === "owner_approved" && ctx.role !== "owner") {
    return { ok: false, reason: "unauthorized" };
  }

  const loaded = await loadGoLiveReadiness(slug);
  if (!loaded.ok) {
    return {
      ok: false,
      reason:
        loaded.reason === "unauthorized" ? "unauthorized" : "unavailable",
    };
  }

  const latestForKey = loaded.latestAttestationEvents.find(
    (event) => event.checkKey === input.checkKey,
  );
  const staleOwnerReapproval =
    input.checkKey === "owner_approved" &&
    input.action === "attest" &&
    loaded.attestationState.ownerApprovalStale;
  if (latestForKey?.action === input.action && !staleOwnerReapproval) {
    return { ok: true, unchanged: true };
  }

  if (input.action === "attest") {
    const scheduleReady =
      loaded.readiness.checks.find((check) => check.id === "schedule")
        ?.state === "pass";
    if (input.checkKey === "hours_confirmed" && !scheduleReady) {
      return { ok: false, reason: "technical_gates_incomplete" };
    }
    if (
      (input.checkKey === "live_rehearsal_completed" ||
        input.checkKey === "owner_approved") &&
      !loaded.readiness.readyForManualReview
    ) {
      return { ok: false, reason: "technical_gates_incomplete" };
    }
    if (
      input.checkKey === "owner_approved" &&
      !allGoLivePrerequisitesConfirmed(loaded.attestationState)
    ) {
      return { ok: false, reason: "prerequisites_incomplete" };
    }
  }

  // Auth and readiness are verified above with the caller's member-scoped
  // client. Writes use the server-only client because authenticated users have
  // no direct INSERT grant on this audit table; this prevents bypassing the
  // server-side technical and prerequisite gates through the Data API.
  const { error } = await createServiceRoleClient()
    .from("salon_go_live_attestations" as never)
    .insert({
      salon_id: ctx.salon.id,
      check_key: input.checkKey,
      action: input.action,
      evidence_note: note,
      actor_user_id: ctx.userId,
      actor_role: ctx.role,
      readiness_snapshot_hash: loaded.snapshotHash,
    } as never);

  if (error) {
    console.error("[recordGoLiveAttestation]", {
      code: error.code,
      checkKey: input.checkKey,
      action: input.action,
    });
    return { ok: false, reason: "unavailable" };
  }

  revalidatePath(
    `/dashboard/${encodeURIComponent(slug)}/settings/readiness`,
  );
  return { ok: true };
}
