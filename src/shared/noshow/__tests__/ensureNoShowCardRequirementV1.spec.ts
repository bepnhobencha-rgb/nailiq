import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ serviceRole: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/release/v1IntegrationScope", () => ({
  v1AllowsNoShowCardOnFile: () => false,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.serviceRole,
}));

import { ensureNoShowCardRequirement } from "@/shared/noshow/ensureNoShowCardRequirement";

describe("disabled no-show card requirement", () => {
  it("resolves not-applicable before database or provider work", async () => {
    await expect(
      ensureNoShowCardRequirement("11111111-1111-4111-8111-111111111111", {
        strict: true,
      }),
    ).resolves.toEqual({ required: false, feeCents: 0 });
    expect(mocks.serviceRole).not.toHaveBeenCalled();
  });
});
