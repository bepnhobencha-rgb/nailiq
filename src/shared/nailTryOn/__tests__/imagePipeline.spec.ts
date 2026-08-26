import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  hasMatchingPublicTryOnSignature,
  preparePublicTryOnUpload,
  prepareTryOnImage,
} from "../imagePipeline";

describe("try-on image pipeline", () => {
  it("shrinks large photos and emits a compact JPEG", async () => {
    const source = await sharp({
      create: { width: 2400, height: 1600, channels: 3, background: "#d8b29a" },
    }).png().toBuffer();

    const output = await prepareTryOnImage(source, 1280);
    const metadata = await sharp(output).metadata();

    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(1280);
    expect(metadata.height).toBe(853);
    expect(output.byteLength).toBeLessThan(100_000);
  });

  it("does not enlarge a small reference image", async () => {
    const source = await sharp({
      create: { width: 480, height: 320, channels: 4, background: "#ffffff00" },
    }).png().toBuffer();

    const output = await prepareTryOnImage(source, 1024);
    const metadata = await sharp(output).metadata();

    expect(metadata.width).toBe(480);
    expect(metadata.height).toBe(320);
  });

  it.each([
    ["image/jpeg", "jpeg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
  ] as const)(
    "accepts a valid %s public upload and normalizes it",
    async (mimeType, format) => {
      const source = await sharp({
        create: {
          width: 900,
          height: 700,
          channels: 3,
          background: "#d8b29a",
        },
      })[format]().toBuffer();

      expect(hasMatchingPublicTryOnSignature(source, mimeType)).toBe(true);
      const result = await preparePublicTryOnUpload(source, mimeType);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const metadata = await sharp(result.buffer).metadata();
      expect(metadata.format).toBe("jpeg");
      expect(metadata.width).toBe(900);
      expect(metadata.height).toBe(700);
    },
  );

  it("rejects malformed bytes with an allowed MIME", async () => {
    const malformed = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);

    await expect(preparePublicTryOnUpload(malformed, "image/jpeg"))
      .resolves.toEqual({ ok: false, error: "invalid_image" });
  });

  it("rejects a valid image disguised behind another MIME", async () => {
    const png = await sharp({
      create: {
        width: 900,
        height: 700,
        channels: 3,
        background: "#d8b29a",
      },
    }).png().toBuffer();

    expect(hasMatchingPublicTryOnSignature(png, "image/jpeg")).toBe(false);
    await expect(preparePublicTryOnUpload(png, "image/jpeg"))
      .resolves.toEqual({ ok: false, error: "invalid_image" });
  });

  it("rejects unsupported declared MIME types before decoding", async () => {
    const gifHeader = Buffer.from("GIF89a", "ascii");

    await expect(preparePublicTryOnUpload(gifHeader, "image/gif"))
      .resolves.toEqual({ ok: false, error: "unsupported_format" });
  });
});
