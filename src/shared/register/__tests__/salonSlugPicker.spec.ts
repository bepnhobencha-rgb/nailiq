import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pickAvailableSalonSlug } from "@/shared/register/salonSlugPicker";

function slugClient(taken: readonly string[]) {
  const checked: string[] = [];
  const takenSet = new Set(taken);
  const client = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn((_column: string, slug: string) => {
          checked.push(slug);
          return {
            maybeSingle: vi.fn().mockResolvedValue({
              data: takenSet.has(slug) ? { id: `salon-${slug}` } : null,
              error: null,
            }),
          };
        }),
      })),
    })),
  } as unknown as SupabaseClient;

  return { client, checked };
}

describe("pickAvailableSalonSlug", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps an authenticated salon slug independent of demo transport flags", async () => {
    vi.stubEnv("DEMO_OTP", "true");
    vi.stubEnv("NEXT_PUBLIC_DEMO_OTP", "true");
    const { client, checked } = slugClient([]);

    await expect(
      pickAvailableSalonSlug(client, "NailIQ Preview QA"),
    ).resolves.toEqual({
      slug: "nailiq-preview-qa",
      slugAdjusted: false,
    });
    expect(checked).toEqual(["nailiq-preview-qa"]);
  });

  it("adds the first available suffix when the requested slug is taken", async () => {
    const { client, checked } = slugClient([
      "nailiq-preview-qa",
      "nailiq-preview-qa-2",
    ]);

    await expect(
      pickAvailableSalonSlug(client, "nailiq-preview-qa"),
    ).resolves.toEqual({
      slug: "nailiq-preview-qa-3",
      slugAdjusted: true,
    });
    expect(checked).toEqual([
      "nailiq-preview-qa",
      "nailiq-preview-qa-2",
      "nailiq-preview-qa-3",
    ]);
  });
});
