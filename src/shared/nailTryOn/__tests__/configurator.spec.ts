import { describe, expect, it } from "vitest";
import { configurationPrompt, DEFAULT_NAIL_CONFIGURATION, nailConfigurationSchema } from "../configurator";

describe("nail configurator", () => {
  it("keeps the natural nail geometry by default", () => {
    expect(configurationPrompt(DEFAULT_NAIL_CONFIGURATION)).toContain("natural nail length");
    expect(configurationPrompt(DEFAULT_NAIL_CONFIGURATION)).toContain("natural nail shape");
  });

  it("instructs AI to create the requested extension and shape", () => {
    const prompt = configurationPrompt({ length: "long", shape: "almond", finish: "chrome", color: "burgundy", artStyle: "design" });
    expect(prompt).toContain("same length as the visible nail bed");
    expect(prompt).toContain("Shape every nail as almond");
    expect(prompt).toContain("deep burgundy");
    expect(prompt).toContain("chrome finish");
  });

  it("makes XX-Long unmistakably longer than Extra-Long", () => {
    const extraLong = configurationPrompt({ length: "extra_long", shape: "coffin", finish: "glossy", color: "design", artStyle: "design" });
    const xxLong = configurationPrompt({ length: "xx_long", shape: "ballerina", finish: "velvet", color: "purple", artStyle: "aura" });
    expect(extraLong).toContain("1.5 times the visible nail-bed length");
    expect(xxLong).toContain("2 times the visible nail-bed length");
    expect(xxLong).toContain("unmistakably longer than Extra-Long");
    expect(xxLong).toContain("magnetic velvet finish");
    expect(xxLong).toContain("centered aura gradient");
  });

  it("defaults older clients to the salon reference design layout", () => {
    const parsed = nailConfigurationSchema.parse({ length: "short", shape: "squoval", finish: "jelly", color: "milky_white" });
    expect(parsed.artStyle).toBe("design");
  });

  it("rejects unsupported configuration values", () => {
    expect(nailConfigurationSchema.safeParse({ length: "huge", shape: "square", finish: "glossy", color: "white", artStyle: "solid" }).success).toBe(false);
  });
});
