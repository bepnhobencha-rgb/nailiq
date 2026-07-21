export const NAIL_TRYON_MAX_BYTES = 10 * 1024 * 1024;
export const NAIL_TRYON_MAX_PIXELS = 20_000_000;
export const NAIL_TRYON_MIN_WIDTH = 720;
export const NAIL_TRYON_MIN_HEIGHT = 720;

export type ClientQualityCode =
  | "pass"
  | "unsupported_format"
  | "file_too_large"
  | "resolution_too_low"
  | "resolution_too_high"
  | "too_dark"
  | "too_bright"
  | "blurred";

export type ClientQualityInput = {
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  meanLuma: number;
  edgeVariance: number;
};

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Fast, inexpensive preflight only. Server-side decoding and hand/nail
 * recognition remain authoritative before any paid generation. */
export function evaluateClientImageQuality(input: ClientQualityInput): ClientQualityCode {
  if (!ALLOWED_TYPES.has(input.mimeType)) return "unsupported_format";
  if (input.bytes > NAIL_TRYON_MAX_BYTES) return "file_too_large";
  if (input.width < NAIL_TRYON_MIN_WIDTH || input.height < NAIL_TRYON_MIN_HEIGHT) {
    return "resolution_too_low";
  }
  if (input.width * input.height > NAIL_TRYON_MAX_PIXELS) return "resolution_too_high";
  if (input.meanLuma < 48) return "too_dark";
  if (input.meanLuma > 235) return "too_bright";
  if (input.edgeVariance < 85) return "blurred";
  return "pass";
}

export function inspectPixels(data: Uint8ClampedArray, width: number, height: number) {
  let lumaTotal = 0;
  let edges = 0;
  let edgeTotal = 0;

  const lumaAt = (offset: number) =>
    data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const current = lumaAt(offset);
      lumaTotal += current;
      if (x > 0) {
        edgeTotal += Math.abs(current - lumaAt(offset - 4));
        edges += 1;
      }
      if (y > 0) {
        edgeTotal += Math.abs(current - lumaAt(offset - width * 4));
        edges += 1;
      }
    }
  }

  return {
    meanLuma: lumaTotal / Math.max(1, width * height),
    edgeVariance: edgeTotal / Math.max(1, edges),
  };
}
