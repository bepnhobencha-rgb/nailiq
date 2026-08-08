import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  maybeSingle: vi.fn(),
  eq: vi.fn(),
  select: vi.fn(),
  from: vi.fn(),
  sendOwnerAlert: vi.fn(),
}));

mocks.eq.mockImplementation(() => ({ maybeSingle: mocks.maybeSingle }));
mocks.select.mockImplementation(() => ({ eq: mocks.eq }));
mocks.from.mockImplementation(() => ({ select: mocks.select }));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/integrations/square/looseDb", () => ({
  looseServiceClient: () => ({ from: mocks.from }),
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => {
    throw new Error("service role must not be reached while permission is off");
  },
}));
vi.mock("@/shared/ai/sendOwnerAlert", () => ({
  sendOwnerAlert: mocks.sendOwnerAlert,
}));

import { runReviewResponder } from "@/shared/ai/agentReviewResponder";

describe("Google Review Responder permission fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    mocks.maybeSingle.mockResolvedValue({
      data: {
        name: "Test Salon",
        google_place_id: "place-123",
        feature_flags: { ai_google_reply: false },
      },
      error: null,
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does not read reviews, invoke AI, write data, or alert the owner when disabled", async () => {
    await expect(runReviewResponder("salon-1")).resolves.toBeUndefined();

    expect(mocks.select).toHaveBeenCalledWith(
      "name, feature_flags, google_place_id",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.sendOwnerAlert).not.toHaveBeenCalled();
  });

  it("fails closed when the feature flag cannot be proven", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { name: "Test Salon", google_place_id: "place-123" },
      error: null,
    });

    await expect(runReviewResponder("salon-1")).resolves.toBeUndefined();

    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.sendOwnerAlert).not.toHaveBeenCalled();
  });
});
