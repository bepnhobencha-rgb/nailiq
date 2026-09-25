import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertReleaseSchemaContract } from "./releaseSchemaContract";

const source = readFileSync(resolve(process.cwd(), "scripts/check-schema-parity.ts"), "utf8");

describe("exact measured release schema contract", () => {
  it("matches the independently rehearsed candidate counts and role grants", () => {
    assertReleaseSchemaContract(source);
  });

  it.each([
    ["tables", 247], ["columns", 3813], ["policies", 225],
    ["functions", 602], ["triggers", 169], ["indexes", 1015],
    ["anon", 57], ["authenticated", 79], ["service_role", 235],
  ] as const)("rejects a changed %s count even if an old expected value remains in a comment", (key, value) => {
    const pattern = new RegExp(`\\b${key}: ${value}\\b`, "g");
    const changed = `${source.replace(pattern, `${key}: ${value + 1}`)}\n// ${key}: ${value}\n`;
    expect(changed).not.toBe(source);
    expect(() => assertReleaseSchemaContract(changed)).toThrow();
  });
});
