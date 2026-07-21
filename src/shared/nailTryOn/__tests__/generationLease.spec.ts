import { describe, expect, it } from "vitest";
import { GENERATION_STALE_MS, isGenerationStale } from "../generationLease";

describe("generation lease", () => {
  const now = Date.parse("2026-07-21T16:00:00.000Z");

  it("does not reclaim an active generation", () => {
    expect(isGenerationStale(new Date(now - GENERATION_STALE_MS + 1).toISOString(), now)).toBe(false);
  });

  it("reclaims a generation whose server request can no longer be running", () => {
    expect(isGenerationStale(new Date(now - GENERATION_STALE_MS).toISOString(), now)).toBe(true);
  });

  it("does not reclaim an invalid timestamp", () => {
    expect(isGenerationStale("not-a-date", now)).toBe(false);
  });
});
