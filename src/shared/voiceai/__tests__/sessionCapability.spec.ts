import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createVoiceSessionCapability,
  verifyVoiceSessionCapability,
} from "@/shared/voiceai/sessionCapability";

describe("voice session capability", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-secret");
    vi.stubEnv("VOICE_SESSION_SIGNING_SECRET", "");
    vi.stubEnv("VOICE_BRIDGE_SECRET", "");
  });

  it("authorizes only the session id it was minted for", () => {
    const token = createVoiceSessionCapability("session-a");
    expect(token).toMatch(/^v1\./);
    expect(verifyVoiceSessionCapability("session-a", token)).toBe(true);
    expect(verifyVoiceSessionCapability("session-b", token)).toBe(false);
  });

  it("rejects missing and tampered capabilities", () => {
    const token = createVoiceSessionCapability("session-a")!;
    expect(verifyVoiceSessionCapability("session-a", null)).toBe(false);
    expect(verifyVoiceSessionCapability("session-a", `${token}x`)).toBe(false);
    expect(verifyVoiceSessionCapability("session-a", `v1.${"a".repeat(43)}`)).toBe(false);
  });

  it("fails closed when no server signing secret is available", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(createVoiceSessionCapability("session-a")).toBeNull();
    expect(verifyVoiceSessionCapability("session-a", "v1.fake")).toBe(false);
  });
});
