import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { prepareTryOnImage } from "../imagePipeline";

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
});
