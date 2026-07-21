import { describe, expect, it } from "vitest";
import { configurationPrompt, DEFAULT_NAIL_CONFIGURATION, nailConfigurationSchema } from "../configurator";

describe("nail configurator", () => {
  it("keeps the natural nail geometry by default", () => {
    expect(configurationPrompt(DEFAULT_NAIL_CONFIGURATION)).toContain("natural nail length");
    expect(configurationPrompt(DEFAULT_NAIL_CONFIGURATION)).toContain("natural nail shape");
  });

  it("instructs AI to create the requested extension and shape", () => {
    const prompt = configurationPrompt({ length: "long", shape: "almond", finish: "chrome", color: "burgundy" });
    expect(prompt).toContain("long salon nail extension");
    expect(prompt).toContain("Shape every nail as almond");
    expect(prompt).toContain("deep burgundy");
    expect(prompt).toContain("chrome finish");
  });

  it("rejects unsupported configuration values", () => {
    expect(nailConfigurationSchema.safeParse({ length: "huge", shape: "square", finish: "glossy", color: "white" }).success).toBe(false);
  });
});
