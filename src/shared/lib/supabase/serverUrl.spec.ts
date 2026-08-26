import { describe, expect, it } from "vitest";
import { resolveSupabaseServerUrl } from "./serverUrl";

describe("resolveSupabaseServerUrl", () => {
  it("prefers a trimmed internal origin", () => {
    expect(
      resolveSupabaseServerUrl({
        SUPABASE_INTERNAL_URL: "  http://127.0.0.1:54321  ",
        NEXT_PUBLIC_SUPABASE_URL: "https://public.example.test/supa",
      }),
    ).toBe("http://127.0.0.1:54321");
  });

  it("falls back to the public origin when the internal origin is blank", () => {
    expect(
      resolveSupabaseServerUrl({
        SUPABASE_INTERNAL_URL: "   ",
        NEXT_PUBLIC_SUPABASE_URL: " https://public.example.test/supa ",
      }),
    ).toBe("https://public.example.test/supa");
  });
});
