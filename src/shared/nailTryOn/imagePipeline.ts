import sharp from "sharp";

export async function prepareTryOnImage(bytes: Buffer, maxDimension: number) {
  return sharp(bytes)
    .rotate()
    .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer();
}
