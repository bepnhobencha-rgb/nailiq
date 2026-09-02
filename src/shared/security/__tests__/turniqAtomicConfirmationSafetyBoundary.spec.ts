import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = join(
  process.cwd(),
  "supabase/migrations/20260902001545_add_turniq_atomic_assignment_revalidation.sql",
);
const sql = readFileSync(migrationPath, "utf8");

describe("TurnIQ M3D atomic confirmation safety boundary", () => {
  it("revalidates only an active recommended TurnIQ assignment", () => {
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION public.enforce_turniq_assignment_confirmation_safety()",
    );
    expect(sql).toMatch(
      /FROM public\.turniq_assignments AS a[\s\S]+a\.booking_id = NEW\.id[\s\S]+a\.status = 'recommended'[\s\S]+FOR UPDATE/,
    );
    expect(sql).toContain("CREATE TRIGGER turniq_assignment_confirmation_safety");
    expect(sql).toContain("BEFORE UPDATE OF");
  });

  it("fails closed on capability, shift, appointment-gap and resource drift", () => {
    expect(sql).toContain("FROM public.staff_services AS ss");
    expect(sql).toMatch(
      /FROM public\.turniq_shift_sessions AS sh[\s\S]+sh\.state = 'active'[\s\S]+FOR UPDATE/,
    );
    expect(sql).toContain("TurnIQ technician appointment gap is no longer safe");
    expect(sql).toContain("TurnIQ resource is no longer available");
    expect(sql).toContain("public.booking_service_segments AS seg");
    expect(sql).toContain("NEW.resource_id IS DISTINCT FROM v_assignment.resource_id");
    expect(sql).toContain("trustedConfirmationSnapshot");
    expect(sql).toContain("TurnIQ recommendation snapshot changed; refresh required");
    expect(sql).toMatch(
      /v_snapshot -> 'shifts' IS DISTINCT FROM v_current_shifts[\s\S]+v_snapshot -> 'capacity' IS DISTINCT FROM v_current_capacity/,
    );
  });

  it("preserves explicit no-resource service truth", () => {
    expect(sql).toMatch(
      /auto_assign_single_booking_resource[\s\S]+v_resource_requirement_mode = 'none'[\s\S]+RETURN NEW/,
    );
    expect(sql).toMatch(
      /v_resources_enabled IS TRUE[\s\S]+v_resource_requirement_mode <> 'none'/,
    );
  });

  it("keeps the trigger helper non-public and provider-free", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.enforce_turniq_assignment_confirmation_safety\(\)[\s\S]+FROM PUBLIC, anon, authenticated/,
    );
    expect(sql).not.toMatch(/twilio|resend|square|stripe|fetch\s*\(/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+public\.(bookings|scheduled_notifications)/i);
  });
});
