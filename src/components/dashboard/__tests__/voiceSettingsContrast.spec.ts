import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/components/dashboard/VoiceSettingsForm.tsx"),
  "utf8",
);

describe("Voice AI native select contrast", () => {
  it("keeps every select and option on the dashboard dark palette", () => {
    expect(source).toContain("[color-scheme:dark]");
    expect(source).toContain("bg-nq-surface");
    expect(source).toContain("text-nq-foreground");
    expect(source.match(/className=\{SELECT_CLASS_NAME\}/g)).toHaveLength(3);
    expect(source.match(/className=\{OPTION_CLASS_NAME\}/g)).toHaveLength(3);
  });
});
