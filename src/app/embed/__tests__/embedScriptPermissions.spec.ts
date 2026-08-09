import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const embedScript = readFileSync(
  resolve(process.cwd(), "public/embed.js"),
  "utf8",
);

describe("booking widget iframe permissions", () => {
  it("delegates microphone access for Voice AI without dropping payment permissions", () => {
    expect(embedScript).toContain(
      'frame.setAttribute("allow", "microphone; payment; clipboard-write")',
    );
  });
});
