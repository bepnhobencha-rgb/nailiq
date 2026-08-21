import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
  createLesson: vi.fn(),
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));
vi.mock("@/shared/ai/lessonMutations", () => ({
  createLesson: mocks.createLesson,
}));

import { analyzeChannelFailures } from "@/shared/ai/analyzeChannelFailures";

describe("channel-failure tenant filter boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects injected salon ids before privileged DB or mutation work", async () => {
    await expect(
      analyzeChannelFailures(
        "11111111-1111-4111-8111-111111111111),salon_id.neq.other",
      ),
    ).resolves.toEqual({
      smsFailRate: 0,
      lessonCreated: false,
      lessonId: null,
    });
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
    expect(mocks.createLesson).not.toHaveBeenCalled();
  });
});
