import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const contracts = fs.readFileSync(
  path.join(root, "src/shared/turniq/serverContracts.ts"),
  "utf8",
);
const actions = fs.readFileSync(
  path.join(root, "src/shared/turniq/serverActions.ts"),
  "utf8",
);
const trusted = fs.readFileSync(
  path.join(root, "src/shared/turniq/trustedRecommendation.ts"),
  "utf8",
);
const page = fs.readFileSync(
  path.join(root, "src/app/dashboard/[slug]/center/page.tsx"),
  "utf8",
);
const dal = fs.readFileSync(
  path.join(root, "src/shared/turniq/serverDal.ts"),
  "utf8",
);

describe("TurnIQ M3C trusted snapshot boundary", () => {
  it("accepts identifiers only and never accepts a client-supplied decision", () => {
    const schema = contracts.slice(
      contracts.indexOf("turnIqRecommendationActionInputSchema"),
      contracts.indexOf("export type TurnIqShiftActionInput"),
    );
    expect(schema).toContain("bookingId");
    expect(schema).toContain("commandId");
    expect(schema).toContain("deviceId");
    expect(schema).not.toContain("recommendedStaffId");
    expect(schema).not.toContain("policyVersionId");
    expect(schema).not.toContain("candidate");
    expect(schema).not.toContain("resourceId");
    expect(schema).not.toContain("decisionInput");
  });

  it("keeps the public action validated and privileged reads server-only", () => {
    expect(actions).toContain("turnIqRecommendationActionInputSchema.safeParse");
    expect(actions).not.toContain("createServiceRoleClient");
    expect(trusted.startsWith('import "server-only"')).toBe(true);
    expect(trusted).toContain("resolveTurnIqContext(input.slug)");
    expect(trusted).toContain("recordTrustedTurnIqRecommendation");
  });

  it("replays exact command receipts and keeps the recommendation intent fingerprint retry-stable", () => {
    expect(trusted).toContain('from("turniq_command_receipts"');
    expect(trusted).toContain('receipt.command_type !== "recommend"');
    expect(trusted).toContain("idempotency_conflict");
    const fingerprintBlock = dal.slice(
      dal.indexOf('kind: "turniq_recommendation_command_v1"'),
      dal.indexOf("const requested = request.requestedTechnician"),
    );
    expect(fingerprintBlock).toContain("bookingId");
    expect(fingerprintBlock).toContain("commandId");
    expect(fingerprintBlock).not.toContain("decisionFingerprint");
    expect(fingerprintBlock).not.toContain("resourceId");
  });

  it("loads every decision truth by exact salon and keeps PII outside the projection", () => {
    expect(trusted).toContain('.eq("salon_id", context.salonId)');
    expect(trusted).toContain('from("turniq_shift_sessions"');
    expect(trusted).toContain('from("staff_services")');
    expect(trusted).toContain('from("salon_resources")');
    expect(trusted).toContain('from("booking_service_segments"');
    expect(trusted).toContain("confirmationSnapshot: trusted.confirmationSnapshot");
    expect(dal).toContain("trustedConfirmationSnapshot: input.confirmationSnapshot");
    expect(trusted).not.toContain("client_name");
    expect(trusted).not.toContain("client_phone");
    expect(trusted).not.toContain("client_email");
    expect(trusted).not.toContain("actual_tip");
  });

  it("mounts the Live Board only through the default-off release flag", () => {
    expect(page).toContain('featureVisible("turniq_trust_engine")');
    expect(page).toContain("turnIqEnabled={turnIqEnabled}");
    expect(page).toContain("turnIqBoardResult?.ok");
  });
});
