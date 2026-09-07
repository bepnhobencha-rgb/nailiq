import { describe, expect, it } from "vitest";
import { serializeJsonLd } from "@/shared/seo/serializeJsonLd";

describe("serializeJsonLd", () => {
  it("preserves normal structured data", () => {
    expect(serializeJsonLd({ name: "NailIQ" })).toBe('{"name":"NailIQ"}');
  });

  it("cannot close the containing script from salon-authored text", () => {
    const serialized = serializeJsonLd({
      name: "</script><script>alert(1)</script>",
    });

    expect(serialized).not.toContain("<");
    expect(JSON.parse(serialized)).toEqual({
      name: "</script><script>alert(1)</script>",
    });
  });
});
