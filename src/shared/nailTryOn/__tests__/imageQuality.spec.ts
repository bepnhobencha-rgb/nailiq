import { describe, expect, it } from "vitest";
import { evaluateClientImageQuality, inspectPixels } from "../imageQuality";

const good = {
  mimeType: "image/jpeg",
  bytes: 2_000_000,
  width: 1800,
  height: 1400,
  meanLuma: 128,
  edgeVariance: 100,
};

describe("evaluateClientImageQuality", () => {
  it("passes a usable image", () => expect(evaluateClientImageQuality(good)).toBe("pass"));
  it("rejects invalid type before decoding", () => expect(evaluateClientImageQuality({ ...good, mimeType: "image/gif" })).toBe("unsupported_format"));
  it("rejects files over 10 MB", () => expect(evaluateClientImageQuality({ ...good, bytes: 10 * 1024 * 1024 + 1 })).toBe("file_too_large"));
  it("rejects low resolution", () => expect(evaluateClientImageQuality({ ...good, width: 640 })).toBe("resolution_too_low"));
  it("rejects excessive pixel counts", () => expect(evaluateClientImageQuality({ ...good, width: 5000, height: 5000 })).toBe("resolution_too_high"));
  it("returns actionable light and blur outcomes", () => {
    expect(evaluateClientImageQuality({ ...good, meanLuma: 30 })).toBe("too_dark");
    expect(evaluateClientImageQuality({ ...good, meanLuma: 245 })).toBe("too_bright");
    expect(evaluateClientImageQuality({ ...good, edgeVariance: 20 })).toBe("blurred");
  });
});

describe("inspectPixels", () => {
  it("computes stable brightness for a flat sample", () => {
    const result = inspectPixels(new Uint8ClampedArray([100, 100, 100, 255, 100, 100, 100, 255]), 2, 1);
    expect(result.meanLuma).toBeCloseTo(100);
    expect(result.edgeVariance).toBe(0);
  });
});
