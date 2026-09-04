import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const actions = readFileSync(
  resolve(root, "src/shared/dashboard/receptionistActions.ts"),
  "utf8",
);
const form = readFileSync(
  resolve(root, "src/components/receptionist/WalkinAddForm.tsx"),
  "utf8",
);
const center = readFileSync(
  resolve(root, "src/components/receptionist/ReceptionistCenter.tsx"),
  "utf8",
);
const idempotencyMigration = readFileSync(
  resolve(
    root,
    "supabase/migrations/20260820083748_authorize_public_booking_pricing.sql",
  ),
  "utf8",
);

describe("walk-in committed-success and retry contract", () => {
  it("persists a client request id behind an existing tenant-scoped unique index", () => {
    expect(actions).toContain("idempotency_key: requestId");
    expect(idempotencyMigration).toContain(
      "ON public.bookings (salon_id, idempotency_key)",
    );
    expect(idempotencyMigration).toContain("group_id IS NULL");
    expect(idempotencyMigration).toContain("recovered_from_booking_id IS NULL");
  });

  it("reuses the same request id across a lost response and both submit paths", () => {
    expect(form).toContain("requestIdentityRef.current?.fingerprint");
    expect(form.match(/requestId,/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(center.match(/requestId: input.requestId/g)?.length ?? 0).toBe(2);
    expect(form).toContain("setErrorMessage(labels.walkinRetrySafe)");
  });

  it("returns committed success when immediate assignment loses a race", () => {
    expect(actions).toContain("assignmentPending: true");
    expect(actions).not.toContain(
      'if (!assigned.ok) {\n    return { ok: false, error: assigned.error };',
    );
    expect(center).toContain("assignmentPending: r.assignmentPending === true");
    expect(form).toContain("labels.walkinSavedAssignmentPending");
  });

  it("binds a replay to the original normalized booking payload", () => {
    for (const field of [
      "service_id",
      "client_name",
      "client_phone",
      "staff_request_note",
      "staff_requested_by_client",
      "walkin_source",
      "walkin_priority",
      "walkin_request_tags",
      "party_size",
    ]) {
      expect(actions).toContain(`replay.${field}`);
    }
    expect(actions).toContain('fail("idempotency_conflict")');
  });

  it("surfaces and blocks an invalid corrected arrival time before submit", () => {
    expect(form).toContain("const nextActualTimeHm = event.target.value");
    expect(form).toContain(
      "nextActualTime.ok ? null : labels.actualTimeInvalid",
    );
    expect(form.match(/!!actualTimeError/g)?.length ?? 0).toBeGreaterThanOrEqual(
      2,
    );
  });
});
