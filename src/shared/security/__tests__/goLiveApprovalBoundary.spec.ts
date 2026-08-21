import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260728220602_go_live_approval_audit.sql",
);
const action = read(
  "src/shared/dashboard/goLiveAttestationAction.ts",
);
const readinessLoader = read(
  "src/shared/dashboard/loadGoLiveReadiness.ts",
);

describe("go-live approval security boundary", () => {
  it("keeps the history append-only and direct member writes closed", () => {
    expect(migration).toContain(
      "REVOKE ALL ON TABLE public.salon_go_live_attestations FROM anon, authenticated",
    );
    expect(migration).toContain(
      "GRANT SELECT ON TABLE public.salon_go_live_attestations TO authenticated",
    );
    expect(migration).toContain(
      "GRANT ALL ON TABLE public.salon_go_live_attestations TO service_role",
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:[^;]*,\s*)?INSERT[^;]*\sTO\s+authenticated/i,
    );
    expect(migration).not.toMatch(
      /FOR\s+(?:UPDATE|DELETE)\s+TO\s+authenticated/i,
    );
  });

  it("authenticates a real owner/admin before the server-only write", () => {
    expect(action).toContain('ctx.kind !== "member"');
    expect(action).toContain("isOwnerOrAdmin(ctx.role)");
    expect(action).toContain(
      'input.checkKey === "owner_approved" && ctx.role !== "owner"',
    );
    expect(action).toContain("createServiceRoleClient()");
  });

  it("requires technical gates and human prerequisites for final approval", () => {
    expect(action).toContain("loaded.readiness.readyForManualReview");
    expect(action).toContain(
      "allGoLivePrerequisitesConfirmed(loaded.attestationState)",
    );
    expect(action).toContain("loaded.snapshotHash");
    expect(action).toContain("loaded.technicalSnapshotHash");
  });

  it("requires the authenticated read-only preview before Guided rehearsal or approval", () => {
    expect(action).toContain("loadGuidedBookingPreviewAvailability");
    expect(action).toContain("guidedPreviewSelection");
    expect(action).toContain("parseGuidedPreviewEvidence");
    expect(action).toContain("latestRehearsal");
    expect(action).toContain('input.action === "attest"');
    expect(action).toContain('reason: "guided_preview_unavailable"');
    expect(action.indexOf("loadGuidedBookingPreviewAvailability")).toBeLessThan(
      action.indexOf("createServiceRoleClient()"),
    );
  });

  it("binds availability configuration and the verified selection to durable proof", () => {
    for (const field of [
      "booking_lead_minutes",
      "resources_enabled",
      "staff_selection_enabled",
      "buffer_minutes",
      "tax_lines",
      "staffShiftSignature",
      "availabilityConfiguration",
    ]) {
      expect(readinessLoader).toContain(field);
    }
    expect(action).toContain("[guided-preview:");
    expect(action).toContain("persistedEvidenceNote.length > 500");
    expect(action).toContain("evidence_note: persistedEvidenceNote");
  });
});
