import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const contracts = read("src/shared/turniq/serverContracts.ts");
const actions = read("src/shared/turniq/serverActions.ts");
const adapter = read("src/shared/turniq/trustedHandoffRecommendation.ts");

describe("TurnIQ M4S trusted multi-service handoff boundary", () => {
  it("keeps browser recommendation input identifier-only", () => {
    const schema = contracts.slice(
      contracts.indexOf("turnIqHandoffRecommendationActionInputSchema"),
      contracts.indexOf("turnIqHandoffConfirmationActionInputSchema"),
    );
    expect(schema).toContain("bookingId: uuid");
    expect(schema).toContain("commandId: uuid");
    expect(schema).not.toContain("staffId");
    expect(schema).not.toContain("resourceId");
    expect(schema).not.toContain("policyVersionId");
    expect(schema).not.toContain("opportunityCreditCents");
    expect(schema).not.toContain("candidateTrace");
  });

  it("validates every Server Action and uses a server-only adapter", () => {
    expect(adapter.startsWith('import "server-only";')).toBe(true);
    expect(actions).toContain("turnIqHandoffRecommendationActionInputSchema.safeParse(input)");
    expect(actions).toContain("turnIqHandoffConfirmationActionInputSchema.safeParse(input)");
    expect(actions).toContain("turnIqHandoffPerformerActionInputSchema.safeParse(input)");
    expect(actions).toContain("recommendTrustedTurnIqHandoff(parsed.data)");
    expect(actions).toContain("confirmTrustedTurnIqHandoff(parsed.data)");
  });

  it("rebuilds decisions from protected segment, shift, capability and policy rows", () => {
    expect(adapter).toContain('from("booking_service_segments" as never)');
    expect(adapter).toContain('from("turniq_shift_sessions" as never)');
    expect(adapter).toContain('from("service_parallel_policies" as never)');
    expect(adapter).toContain("buildTrustedTurnIqHandoffDecisionInput");
    expect(adapter).toContain("decideTurnIqMultiTechnicianHandoff");
    expect(adapter).toContain('"record_turniq_handoff_plan_v1"');
    expect(adapter).toContain('"confirm_turniq_handoff_plan_v1"');
    expect(adapter).toContain('"apply_turniq_handoff_performer_command_v1"');
  });

  it("never silently rewrites the committed booking assignment", () => {
    expect(adapter).toContain("segment.staffId !== assignment.staffId");
    expect(adapter).toContain("segment.resourceId !== assignment.resourceId");
    expect(adapter).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
    expect(adapter).not.toMatch(/Square|Stripe|Twilio|Resend/);
  });
});
