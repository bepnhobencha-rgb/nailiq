import { beforeEach, describe, expect, it, vi } from "vitest";

const aiMocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/ai/anthropicProviderPolicy", () => ({
  createTextBackgroundAnthropicClient: () => ({
    messages: { create: aiMocks.create },
  }),
}));
vi.mock("../usageLedger", () => ({
  trackAnthropicMessage: async (
    _context: unknown,
    execute: () => Promise<unknown>,
  ) => execute(),
  isProviderTimeoutError: (error: unknown) =>
    error instanceof Error && error.name === "APIConnectionTimeoutError",
}));

let salonSelect = "";
let salonError: { message: string } | null = null;
let savedProfile: Record<string, unknown> | null = null;

const salon = {
  id: "salon-123",
  name: "NailIQ Test",
  slug: "nailiq-test",
  default_language: "vi",
  timezone: "America/Vancouver",
  vertical: "nail_salon",
  noshow_protection_enabled: false,
};

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "salons") {
        let updating = false;
        const chain = {
          select: (columns: string) => {
            salonSelect = columns;
            return chain;
          },
          eq: vi.fn(() =>
            updating ? Promise.resolve({ data: null, error: null }) : chain,
          ),
          single: vi.fn(async () => ({
            data: salonError ? null : salon,
            error: salonError,
          })),
          update: (payload: { ai_profile: Record<string, unknown> }) => {
            updating = true;
            savedProfile = payload.ai_profile;
            return chain;
          },
        };
        return chain;
      }

      if (table === "services") {
        const chain = {
          select: () => chain,
          eq: () => chain,
          is: () => chain,
          order: () => chain,
          limit: vi.fn(async () => ({ data: [], error: null })),
        };
        return chain;
      }

      if (table === "bookings") {
        const chain = {
          select: () => chain,
          eq: () => chain,
          gte: vi.fn(async () => ({ data: [], error: null })),
        };
        return chain;
      }

      throw new Error(`unexpected table: ${table}`);
    },
  }),
}));

import { buildSip } from "../buildSip";

describe("buildSip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    salonSelect = "";
    salonError = null;
    savedProfile = null;
    aiMocks.create.mockReset();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("loads the production schema language field and preserves it in the fallback SIP", async () => {
    const sip = await buildSip(salon.id);

    expect(salonSelect).toContain("default_language");
    expect(salonSelect).not.toMatch(/(^|,\s*)language(,|$)/);
    expect(sip.language_primary).toBe("vi");
    expect(savedProfile).toMatchObject({
      language_primary: "vi",
      built_via: "settings_change",
    });
  });

  it("surfaces a salon query failure instead of reporting a false not-found error", async () => {
    salonError = { message: 'column salons.language does not exist' };

    await expect(buildSip(salon.id)).rejects.toThrow(
      "buildSip: failed to load salon salon-123: column salons.language does not exist",
    );
  });

  it("does not persist a fallback SIP after a provider timeout", async () => {
    process.env.ANTHROPIC_API_KEY = "qa-key";
    const timeout = Object.assign(new Error("deadline exceeded"), {
      name: "APIConnectionTimeoutError",
    });
    aiMocks.create.mockRejectedValue(timeout);

    await expect(buildSip(salon.id)).rejects.toBe(timeout);
    expect(savedProfile).toBeNull();
  });
});
