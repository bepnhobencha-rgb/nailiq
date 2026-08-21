import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => fn,
}));

const createServiceRoleClient = vi.fn();
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));

import { getLessons } from "@/shared/ai/lessons";

describe("Minh lesson tenant filter boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects PostgREST grammar before creating a privileged client", async () => {
    await expect(
      getLessons(
        "11111111-1111-4111-8111-111111111111),salon_id.neq.other",
        "channel",
      ),
    ).resolves.toEqual([]);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("fails explicitly in strict mode without a privileged read", async () => {
    await expect(
      getLessons("not-a-uuid", "channel", { throwOnError: true }),
    ).rejects.toThrow("invalid_salon_id");
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });
});
