import { describe, expect, it } from "vitest";
import {
  NAIL_TRYON_CAPTURE_LAYOUT_INSTRUCTION,
  nailTryOnQualityPrompt,
  parseNailTryOnCaptureMode,
} from "../captureMode";

describe("Nail Try-On capture modes", () => {
  it("defaults unknown input to the safe single-photo mode", () => {
    expect(parseNailTryOnCaptureMode(undefined)).toBe("single");
    expect(parseNailTryOnCaptureMode("unexpected")).toBe("single");
  });

  it("recognizes the 4+1 fallback without treating it as two hands", () => {
    expect(parseNailTryOnCaptureMode("four_plus_one")).toBe("four_plus_one");
    expect(nailTryOnQualityPrompt("four_plus_one")).toContain("same hand");
    expect(nailTryOnQualityPrompt("four_plus_one")).toContain("five nail plates");
  });

  it("tells generation to preserve both capture-board panels", () => {
    expect(NAIL_TRYON_CAPTURE_LAYOUT_INSTRUCTION).toContain("preserve its two-panel layout");
    expect(NAIL_TRYON_CAPTURE_LAYOUT_INSTRUCTION).toContain("thumbnail");
  });
});
