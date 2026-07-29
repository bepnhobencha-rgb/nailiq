import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const actions = readFileSync(
  resolve(process.cwd(), "src/shared/dashboard/salonOwnerActions.ts"),
  "utf8",
);
const hub = readFileSync(
  resolve(process.cwd(), "src/components/dashboard/AiManagerHub.tsx"),
  "utf8",
);

describe("AI agent activation boundary", () => {
  it("validates the runtime key before any salon write", () => {
    const validation = actions.indexOf("if (!isAiAgentFlagKey(flagKey))");
    const writeContext = actions.indexOf(
      "getDashboardWriteClient(slug)",
      validation,
    );
    expect(validation).toBeGreaterThan(-1);
    expect(writeContext).toBeGreaterThan(validation);
    expect(actions).toContain('if (typeof enabled !== "boolean")');
    expect(actions).toContain('error: "invalid_enabled_value"');
  });

  it("fails closed when impact acknowledgement is missing", () => {
    expect(actions).toContain("requiresAiAgentEnableAcknowledgement(flagKey)");
    expect(actions).toContain('error: "impact_confirmation_required"');
    expect(actions).toContain("options?.impactAcknowledged !== true");
  });

  it("does not mistake unrelated salon flags for an enabled AI agent", () => {
    expect(actions).toContain("AI_AGENT_FLAG_KEYS.some(");
    expect(actions).not.toContain("Object.values(current).some(Boolean)");
  });

  it("presents the impact and asks before activating sensitive agents", () => {
    expect(hub).toContain("window.confirm(");
    expect(hub).toContain("data-impact={impact}");
    expect(hub).toContain("impactAcknowledged: needsAcknowledgement");
    expect(hub).not.toContain("safe to enable without risk of over-messaging");
  });
});
