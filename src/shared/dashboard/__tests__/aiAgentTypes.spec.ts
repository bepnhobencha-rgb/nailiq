import { describe, expect, it } from "vitest";

import {
  AI_AGENT_FLAG_KEYS,
  AI_AGENT_IMPACT,
  isAiAgentFlagKey,
  requiresAiAgentEnableAcknowledgement,
} from "@/shared/dashboard/aiAgentTypes";

describe("AI agent activation policy", () => {
  it("classifies every allowlisted agent exactly once", () => {
    expect(Object.keys(AI_AGENT_IMPACT).sort()).toEqual(
      [...AI_AGENT_FLAG_KEYS].sort(),
    );
  });

  it("requires explicit acknowledgement for customer and booking impact", () => {
    expect(requiresAiAgentEnableAcknowledgement("ai_winback")).toBe(true);
    expect(requiresAiAgentEnableAcknowledgement("ai_vip_care")).toBe(true);
    expect(
      requiresAiAgentEnableAcknowledgement("ai_noshow_policy_live"),
    ).toBe(true);
    expect(requiresAiAgentEnableAcknowledgement("ai_social_content")).toBe(
      false,
    );
    expect(requiresAiAgentEnableAcknowledgement("ai_watchdog")).toBe(false);
  });

  it("rejects unknown runtime flag keys", () => {
    expect(isAiAgentFlagKey("ai_winback")).toBe(true);
    expect(isAiAgentFlagKey("unlimited_bookings")).toBe(false);
    expect(isAiAgentFlagKey("ai_unknown")).toBe(false);
    expect(isAiAgentFlagKey(null)).toBe(false);
  });
});
