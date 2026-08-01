import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  normalizePublicBookingSlug,
  validatePublicBookingSlug,
} from "@/shared/booking/normalizePublicBookingSlug";
import { resolvePublicBookingPage } from "@/shared/booking/resolvePublicBookingPage";

describe("public booking slug boundary", () => {
  it.each([
    "tech-nails",
    "hilite-anaheim",
    "nailiq-qa-2026-07-26",
    "a1-nails-2",
  ])("accepts a registration-compatible slug: %s", (slug) => {
    expect(validatePublicBookingSlug(slug)).toBe(true);
  });

  it.each([
    "wp-config.php",
    "wp-config.php.bak",
    ".env",
    "admin.php",
    "../tech-nails",
    "tech_nails",
    "-tech-nails",
    "tech-nails-",
    "tech--nails",
    "tech nails",
    "téch-nails",
  ])("rejects a segment that registration can never create: %s", (slug) => {
    expect(validatePublicBookingSlug(slug)).toBe(false);
  });

  it("normalizes case and percent encoding before validation", () => {
    const normalized = normalizePublicBookingSlug("  Tech%2DNails  ");

    expect(normalized).toBe("tech-nails");
    expect(validatePublicBookingSlug(normalized)).toBe(true);
  });

  it("rejects an encoded scanner path after normalization", () => {
    const normalized = normalizePublicBookingSlug("wp-config%2Ephp");

    expect(normalized).toBe("wp-config.php");
    expect(validatePublicBookingSlug(normalized)).toBe(false);
  });

  it("rejects scanner traffic before constructing a Supabase query", async () => {
    const client = new Proxy(
      {},
      {
        get: (_target, property) => {
          throw new Error(`unexpected Supabase access: ${String(property)}`);
        },
      },
    ) as SupabaseClient;

    await expect(
      resolvePublicBookingPage("wp-config.php.bak", client),
    ).resolves.toEqual({
      status: "not_found",
      normalizedSlug: "wp-config.php.bak",
    });
  });
});
