"use server";

import { revalidatePath } from "next/cache";
import {
  allGoLivePrerequisitesConfirmed,
  GO_LIVE_ATTESTATION_KEYS,
  isGuidedPilotAttestationBlocked,
  type GoLiveAttestationAction,
  type GoLiveAttestationKey,
  type GoLiveAttestationState,
} from "@/shared/dashboard/goLiveAttestations";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { loadGoLiveReadiness } from "@/shared/dashboard/loadGoLiveReadiness";
import { loadGuidedBookingPreviewAvailability } from "@/shared/dashboard/loadGuidedBookingPreviewAvailability";
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
        | "guided_preview_unavailable"
        | "unavailable";
    };

export type GuidedPreviewSelection = {
  serviceId: string;
  staffId: string;
  dateYmd: string;
  timeLabel: string;
};

const GUIDED_PREVIEW_EVIDENCE_PREFIX = "[guided-preview:";

function guidedPreviewEvidenceMarker(
  selection: GuidedPreviewSelection,
): string {
  return `${GUIDED_PREVIEW_EVIDENCE_PREFIX}${JSON.stringify(selection)}]`;
}

function parseGuidedPreviewEvidence(
  evidenceNote: string,
): GuidedPreviewSelection | null {
  const lines = evidenceNote.split("\n");
  const marker = lines[lines.length - 1] ?? "";
  if (!marker.startsWith(GUIDED_PREVIEW_EVIDENCE_PREFIX) || !marker.endsWith("]")) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      marker.slice(GUIDED_PREVIEW_EVIDENCE_PREFIX.length, -1),
    ) as Partial<GuidedPreviewSelection>;
    if (
      typeof parsed.serviceId !== "string" ||
      !parsed.serviceId ||
      typeof parsed.staffId !== "string" ||
      !parsed.staffId ||
      typeof parsed.dateYmd !== "string" ||
      !parsed.dateYmd ||
      typeof parsed.timeLabel !== "string" ||
      !parsed.timeLabel
    ) {
      return null;
    }
    return parsed as GuidedPreviewSelection;
  } catch {
    return null;
  }
}

function isAttestationCurrent(
  checkKey: GoLiveAttestationKey,
  state: GoLiveAttestationState,
): boolean {
  switch (checkKey) {
    case "hours_confirmed":
      return state.hoursConfirmed;
    case "otp_policy_confirmed":
      return state.otpPolicyConfirmed;
    case "live_rehearsal_completed":
      return state.liveRehearsalCompleted;
    case "owner_approved":
      return state.ownerApproved;
  }
}

export async function recordGoLiveAttestation(
  slug: string,
  input: {
    checkKey: GoLiveAttestationKey;
    action: GoLiveAttestationAction;
    evidenceNote: string;
    guidedPreviewSelection?: GuidedPreviewSelection;
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
  const guidedPreviewRequired =
    loaded.guidedSetupEnabled &&
    input.action === "attest" &&
    (input.checkKey === "live_rehearsal_completed" ||
      input.checkKey === "owner_approved");
  let guidedPreviewAvailable = true;
  let persistedEvidenceNote = note;
  if (
    guidedPreviewRequired &&
    input.checkKey === "live_rehearsal_completed"
  ) {
    const selection = input.guidedPreviewSelection;
    if (
      !selection ||
      typeof selection.serviceId !== "string" ||
      typeof selection.staffId !== "string" ||
      typeof selection.dateYmd !== "string" ||
      typeof selection.timeLabel !== "string" ||
      !selection.timeLabel.trim()
    ) {
      return { ok: false, reason: "invalid_input" };
    }
    const availability = await loadGuidedBookingPreviewAvailability({
      slug,
      serviceId: selection.serviceId,
      staffId: selection.staffId,
      dateYmd: selection.dateYmd,
    });
    const canonicalSlot = availability.ok
      ? availability.slots.find(
          (slot) =>
            slot.available && slot.label === selection.timeLabel.trim(),
        )
      : undefined;
    guidedPreviewAvailable = Boolean(canonicalSlot);
    if (availability.ok && canonicalSlot) {
      const canonicalSelection = {
        serviceId: selection.serviceId,
        staffId: selection.staffId.trim(),
        dateYmd: availability.dateYmd,
        timeLabel: canonicalSlot.label,
      };
      // Store the server-verified, normalized selection alongside the human
      // note. This compact marker contains only internal IDs/date/time and
      // makes the audit proof reconstructable without a schema migration.
      persistedEvidenceNote = `${note}\n${guidedPreviewEvidenceMarker(canonicalSelection)}`;
      if (persistedEvidenceNote.length > 500) {
        return { ok: false, reason: "invalid_input" };
      }
    }
  } else if (guidedPreviewRequired) {
    const latestRehearsal = loaded.latestAttestationEvents.find(
      (event) => event.checkKey === "live_rehearsal_completed",
    );
    const selection =
      latestRehearsal?.action === "attest"
        ? parseGuidedPreviewEvidence(latestRehearsal.evidenceNote)
        : null;
    if (!selection) {
      guidedPreviewAvailable = false;
    } else {
      const availability = await loadGuidedBookingPreviewAvailability({
        slug,
        serviceId: selection.serviceId,
        staffId: selection.staffId,
        dateYmd: selection.dateYmd,
      });
      guidedPreviewAvailable =
        availability.ok &&
        availability.slots.some(
          (slot) => slot.available && slot.label === selection.timeLabel,
        );
    }
  }
  if (
    isGuidedPilotAttestationBlocked(
      loaded.guidedSetupEnabled,
      input.checkKey,
      guidedPreviewAvailable,
    )
  ) {
    return { ok: false, reason: "guided_preview_unavailable" };
  }

  const latestForKey = loaded.latestAttestationEvents.find(
    (event) => event.checkKey === input.checkKey,
  );
  const sameActionIsCurrent =
    input.action === "revoke" ||
    isAttestationCurrent(input.checkKey, loaded.attestationState);
  if (latestForKey?.action === input.action && sameActionIsCurrent) {
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
      evidence_note: persistedEvidenceNote,
      actor_user_id: ctx.userId,
      actor_role: ctx.role,
      readiness_snapshot_hash:
        input.checkKey === "owner_approved"
          ? loaded.snapshotHash
          : loaded.technicalSnapshotHash,
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
