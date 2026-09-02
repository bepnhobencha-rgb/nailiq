import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const contracts = readFileSync(
  join(process.cwd(), "src/shared/turniq/serverContracts.ts"),
  "utf8",
);
const actions = readFileSync(
  join(process.cwd(), "src/shared/turniq/serverActions.ts"),
  "utf8",
);
const adapter = readFileSync(
  join(process.cwd(), "src/shared/turniq/trustedGroupRecommendation.ts"),
  "utf8",
);

describe("TurnIQ M4C trusted group server boundary", () => {
  it("keeps browser input identifier-only", () => {
    const schema = contracts.slice(
      contracts.indexOf("turnIqGroupRecommendationActionInputSchema"),
      contracts.indexOf("turnIqGroupConfirmationActionInputSchema"),
    );
    expect(schema).toContain("bookingGroupId: uuid");
    expect(schema).toContain("commandId: uuid");
    expect(schema).not.toContain("recommendedStaffId");
    expect(schema).not.toContain("resourceId");
    expect(schema).not.toContain("policyVersionId");
    expect(schema).not.toContain("objectiveScore");
    expect(schema).not.toContain("internalDecisionTrace");
  });

  it("validates every Server Action and delegates to the server-only adapter", () => {
    expect(actions).toContain(
      "turnIqGroupRecommendationActionInputSchema.safeParse(input)",
    );
    expect(actions).toContain(
      "turnIqGroupConfirmationActionInputSchema.safeParse(input)",
    );
    expect(actions).toContain("recommendTrustedTurnIqGroup(parsed.data)");
    expect(actions).toContain("confirmTrustedTurnIqGroup(parsed.data)");
    expect(adapter.startsWith('import "server-only";')).toBe(true);
  });

  it("re-authorizes tenant/role, replays commands and derives decisions server-side", () => {
    expect(adapter).toContain("resolveTurnIqContext(input.slug)");
    expect(adapter).toContain("canUseTurnIqLiveBoard(context.role)");
    expect(adapter).toContain("replayGroupCommand");
    expect(adapter).toContain("buildTrustedTurnIqGroupDecisionInput");
    expect(adapter).toContain("decideTurnIqGroup");
    expect(adapter).toContain('"record_turniq_group_plan_v1"');
    expect(adapter).toContain('"confirm_turniq_group_plan_v1"');
  });

  it("fails closed instead of silently moving booked group members", () => {
    expect(adapter).toContain("Staggered group");
    expect(adapter).toContain(
      "assignment.startsAt !== new Date(booking.startAt).toISOString()",
    );
    expect(adapter).toContain("assignment.resourceIds.length > 1");
  });
});
