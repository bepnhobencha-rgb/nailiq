/**
 * Client-only Canvas-based brand-color extraction for the Settings →
 * Brand Color picker. Replaces the server-side Claude Vision flow
 * for the logo / screenshot upload path; runs entirely in the
 * browser so we never hit a CDN block, never need an API key, and
 * never send the salon owner's image bytes anywhere.
 *
 * `extractDominantColor(file)` is the lighter helper used for the
 * "Upload logo" button.
 * `extractDominantColorAndTheme(file)` adds a brightness sample
 * over the four corners for the "Upload screenshot" button, which
 * also wants to auto-pick light/dark theme mode.
 *
 * Both return `null` if no usable color can be extracted (image
 * load failed, canvas read failed, all pixels filtered as
 * near-white/black/gray, or the file is too large).
 */

export const EXTRACT_FILE_MAX_BYTES = 5 * 1024 * 1024;

export const EXTRACT_ACCEPTED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export const EXTRACT_ACCEPTED_MIME_ATTR = EXTRACT_ACCEPTED_MIME_TYPES.join(",");

/** Canvas read window — bounding box for the resized image. */
const MAX_SIDE = 200;

/** Pixel-filter thresholds. Tuned to drop the visual chrome of a
 *  typical logo (white card, black text) so only the brand accent
 *  remains in the histogram. */
const NEAR_WHITE_MIN = 240;
const NEAR_BLACK_MAX = 15;
const NEAR_GRAY_CHANNEL_SPREAD = 30;

/** Sample-window around each corner for the screenshot theme
 *  detector. 3×3 per corner = 9 pixels × 4 corners = 36 samples
 *  total (spec said "20 from 4 corners" — 36 is the same ballpark
 *  and avoids edge-case sampling outside tiny images). */
const CORNER_SAMPLE_RADIUS = 3;
/** Brightness threshold above which the image is considered light. */
const LIGHT_DARK_BRIGHTNESS_CUTOFF = 128;

export type DominantColorResult = {
  /** `#RRGGBB`, uppercase. */
  color: string;
  /** A data-URL preview suitable for `<img src={preview}>`. */
  preview: string;
};

export type DominantColorAndThemeResult = DominantColorResult & {
  themeMode: "light" | "dark";
};

export async function extractDominantColor(
  file: File,
): Promise<DominantColorResult | null> {
  const loaded = await loadImageDataFromFile(file);
  if (!loaded) return null;
  const color = pickDominantColor(loaded.data);
  if (!color) return null;
  return { color, preview: loaded.preview };
}

export async function extractDominantColorAndTheme(
  file: File,
): Promise<DominantColorAndThemeResult | null> {
  const loaded = await loadImageDataFromFile(file);
  if (!loaded) return null;
  const color = pickDominantColor(loaded.data);
  if (!color) return null;
  const themeMode = detectThemeBrightness(
    loaded.data,
    loaded.width,
    loaded.height,
  );
  return { color, themeMode, preview: loaded.preview };
}

/* ───────────────── internals ───────────────── */

type LoadedImage = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  preview: string;
};

async function loadImageDataFromFile(file: File): Promise<LoadedImage | null> {
  if (!(file instanceof File)) return null;
  if (file.size > EXTRACT_FILE_MAX_BYTES) return null;
  if (typeof window === "undefined") return null;

  const dataUrl = await readFileAsDataUrl(file);
  if (!dataUrl) return null;

  const img = await loadImage(dataUrl);
  if (!img) return null;

  const aspect = img.width / Math.max(img.height, 1);
  const width =
    aspect >= 1 ? MAX_SIDE : Math.max(1, Math.round(MAX_SIDE * aspect));
  const height =
    aspect >= 1 ? Math.max(1, Math.round(MAX_SIDE / aspect)) : MAX_SIDE;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(img, 0, 0, width, height);

  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(0, 0, width, height);
  } catch {
    // Same-origin data URLs shouldn't taint the canvas, but bail
    // cleanly if some browser surprises us.
    return null;
  }

  return {
    data: imageData.data,
    width,
    height,
    preview: dataUrl,
  };
}

function readFileAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      resolve(typeof result === "string" ? result : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/** 4-bit-per-channel histogram of "interesting" pixels, picks the
 *  most-frequent bucket and returns its centroid as `#RRGGBB`. */
function pickDominantColor(pixels: Uint8ClampedArray): string | null {
  const buckets = new Map<number, number>();

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    const a = pixels[i + 3] ?? 0;
    if (a < 128) continue;

    // Near-white / near-black: skip the page chrome.
    if (
      r > NEAR_WHITE_MIN &&
      g > NEAR_WHITE_MIN &&
      b > NEAR_WHITE_MIN
    ) {
      continue;
    }
    if (
      r < NEAR_BLACK_MAX &&
      g < NEAR_BLACK_MAX &&
      b < NEAR_BLACK_MAX
    ) {
      continue;
    }
    // Near-gray: text / borders / shadows.
    const channelMax = Math.max(r, g, b);
    const channelMin = Math.min(r, g, b);
    if (channelMax - channelMin < NEAR_GRAY_CHANNEL_SPREAD) continue;

    // 4 bits per channel → 16 levels per channel, 4096 buckets total.
    const bucket = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }

  if (buckets.size === 0) return null;

  let bestBucket = 0;
  let bestCount = 0;
  for (const [bucket, count] of buckets) {
    if (count > bestCount) {
      bestCount = count;
      bestBucket = bucket;
    }
  }

  // Centroid of the 16-wide bucket on each channel (+8 = mid-point).
  const r = ((bestBucket >> 8) & 0xf) * 16 + 8;
  const g = ((bestBucket >> 4) & 0xf) * 16 + 8;
  const b = (bestBucket & 0xf) * 16 + 8;
  return `#${[r, g, b]
    .map((v) => Math.min(255, v).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

/** Average brightness across the four corners — light vs dark page. */
function detectThemeBrightness(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): "light" | "dark" {
  if (width === 0 || height === 0) return "dark";

  const corners: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];

  let totalBrightness = 0;
  let samples = 0;

  for (const [cx, cy] of corners) {
    for (let dx = 0; dx < CORNER_SAMPLE_RADIUS; dx++) {
      for (let dy = 0; dy < CORNER_SAMPLE_RADIUS; dy++) {
        // Walk inward from each corner — for top-left (cx=0) we move
        // +dx +dy, for top-right (cx=w-1) we move -dx +dy, etc.
        const x = cx === 0 ? dx : cx - dx;
        const y = cy === 0 ? dy : cy - dy;
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        const idx = (y * width + x) * 4;
        const r = pixels[idx] ?? 0;
        const g = pixels[idx + 1] ?? 0;
        const b = pixels[idx + 2] ?? 0;
        totalBrightness += (r + g + b) / 3;
        samples += 1;
      }
    }
  }

  if (samples === 0) return "dark";
  const avg = totalBrightness / samples;
  return avg > LIGHT_DARK_BRIGHTNESS_CUTOFF ? "light" : "dark";
}
