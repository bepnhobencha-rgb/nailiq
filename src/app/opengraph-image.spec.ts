import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import OpengraphImage, { alt, contentType, size } from "./opengraph-image";

describe("Open Graph image artifact", () => {
  it("renders an exact 1200x630 PNG instead of only compiling the route", async () => {
    const response = OpengraphImage();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");

    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(bytes.readUInt32BE(16)).toBe(1200);
    expect(bytes.readUInt32BE(20)).toBe(630);
    expect(bytes.byteLength).toBeGreaterThan(20_000);
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
    expect(alt).toContain("NailIQ");
  });

  it("does not require a remote emoji asset to render", () => {
    const source = readFileSync(new URL("./opengraph-image.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("🇨🇦");
    expect(source).toContain("Vancouver, BC, Canada");
  });
});
