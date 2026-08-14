import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const action = readFileSync(
  resolve(process.cwd(), "src/shared/superadmin/privacyActions.ts"),
  "utf8",
);

describe("terminal booking privacy action boundary", () => {
  it("derives the operator from the authenticated session and admits only privacy operators", () => {
    expect(action).toContain("await session.auth.getUser()");
    expect(action).toContain("await getSuperAdminRole(user.id)");
    expect(action).toContain(
      'const PRIVACY_OPERATOR_ROLES = new Set(["founder", "ops_admin"]);',
    );
    expect(action).toContain("!PRIVACY_OPERATOR_ROLES.has(role)");
    expect(action).not.toMatch(/actorUserId\??\s*:/);
    expect(action).not.toMatch(/actorRole\??\s*:/);
  });

  it("accepts only UUID scope plus a fixed non-PII reason code", () => {
    expect(action).toContain("bookingId: string");
    expect(action).toContain("salonId: string");
    expect(action).toContain("requestId: string");
    expect(action).toContain("reasonCode: TerminalBookingPrivacyReason");
    expect(action).toContain('"verified_erasure_request"');
    expect(action).toContain('"verified_retention_expiry"');
    expect(action).toContain('"verified_legal_correction"');
    expect(action).not.toMatch(/customer(Name|Phone|Email|Id)\??\s*:/);
    expect(action).not.toMatch(/(?:notes?|reason)\??\s*:\s*string/i);
  });

  it("delegates mutation and audit to the service-only RPC without a second app write", () => {
    expect(action).toContain("createServiceRoleClient()");
    expect(action).toContain('"redact_terminal_booking_for_privacy" as never');
    expect(action).toContain("p_actor_user_id: user.id");
    expect(action).toContain('scope: "single_terminal_booking"');
    expect(action).toContain("relatedRecordsRequireSeparateWorkflow");
    expect(action).not.toContain('.from("bookings")');
    expect(action).not.toContain("superadmin_audit_logs");
  });
});
