import sharp from "sharp";
import { isBlockingNailTryOnResolution } from "./imageQuality";

const MAX_INPUT_PIXELS = 20_000_000;

const MIME_FORMAT = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RIFF_SIGNATURE = Buffer.from("RIFF", "ascii");
const WEBP_SIGNATURE = Buffer.from("WEBP", "ascii");

export type PublicTryOnImageError =
  | "unsupported_format"
  | "invalid_image"
  | "resolution_too_low";

export type PreparedPublicTryOnImage =
  | { ok: true; buffer: Buffer }
  | { ok: false; error: PublicTryOnImageError };

function startsWith(bytes: Buffer, signature: Buffer, offset = 0): boolean {
  return bytes.length >= offset + signature.length
    && bytes.subarray(offset, offset + signature.length).equals(signature);
}

/**
 * Reject a declared MIME type that does not match the file signature before
 * the public upload reaches Sharp or any storage/provider boundary.
 */
export function hasMatchingPublicTryOnSignature(
  bytes: Buffer,
  declaredMimeType: string,
): boolean {
  if (declaredMimeType === "image/jpeg") return startsWith(bytes, JPEG_SIGNATURE);
  if (declaredMimeType === "image/png") return startsWith(bytes, PNG_SIGNATURE);
  if (declaredMimeType === "image/webp") {
    return startsWith(bytes, RIFF_SIGNATURE) && startsWith(bytes, WEBP_SIGNATURE, 8);
  }
  return false;
}

/**
 * Decode and normalize a public Try-On upload only after its declared MIME,
 * magic bytes, decoded format, dimensions and pixel budget agree.
 */
export async function preparePublicTryOnUpload(
  bytes: Buffer,
  declaredMimeType: string,
): Promise<PreparedPublicTryOnImage> {
  const expectedFormat = MIME_FORMAT[declaredMimeType as keyof typeof MIME_FORMAT];
  if (!expectedFormat) return { ok: false, error: "unsupported_format" };
  if (!hasMatchingPublicTryOnSignature(bytes, declaredMimeType)) {
    return { ok: false, error: "invalid_image" };
  }

  try {
    const metadata = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (metadata.format !== expectedFormat) {
      return { ok: false, error: "invalid_image" };
    }
    if (
      !metadata.width
      || !metadata.height
      || isBlockingNailTryOnResolution(metadata.width, metadata.height)
    ) {
      return { ok: false, error: "resolution_too_low" };
    }

    const buffer = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();
    return { ok: true, buffer };
  } catch {
    return { ok: false, error: "invalid_image" };
  }
}

export async function prepareTryOnImage(bytes: Buffer, maxDimension: number) {
  return sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer();
}
