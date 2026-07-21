import { describe, it, expect } from "vitest";
import { formatTranscript } from "../formatTranscript";

describe("formatTranscript", () => {
  it("renders a JSONB turn array as a readable script (the [object Object] fix)", () => {
    const t = [
      { role: "ai", text: "Hi, thanks for calling..." },
      { role: "user", text: "I would like a manicure" },
      { role: "ai", text: "Let me check..." },
    ];
    expect(formatTranscript(t)).toBe(
      "Lily: Hi, thanks for calling...\nKhách: I would like a manicure\nLily: Let me check...",
    );
    expect(formatTranscript(t)).not.toContain("[object Object]");
  });

  it("shows a legacy plain-string transcript as-is", () => {
    expect(formatTranscript("Old transcript text")).toBe("Old transcript text");
  });

  it("parses a transcript stored as a JSON string", () => {
    const json = JSON.stringify([{ role: "user", text: "hello" }]);
    expect(formatTranscript(json)).toBe("Khách: hello");
  });

  it("does not crash on null / malformed / unexpected values", () => {
    expect(formatTranscript(null)).toBeNull();
    expect(formatTranscript(undefined)).toBeNull();
    expect(formatTranscript("")).toBeNull();
    expect(formatTranscript("{ broken json")).toBe("{ broken json");
    expect(formatTranscript(42)).toBeNull();
    expect(formatTranscript({ not: "an array" })).toBeNull();
  });

  it("skips invalid array elements rather than failing", () => {
    const t = [
      { role: "ai", text: "kept" },
      null,
      "string element",
      { role: "user" },            // no text
      { role: "user", text: "" },  // empty text
      { role: "user", text: "also kept" },
    ];
    expect(formatTranscript(t)).toBe("Lily: kept\nKhách: also kept");
  });

  it("returns null when nothing legible remains", () => {
    expect(formatTranscript([null, { role: "ai" }, {}])).toBeNull();
    expect(formatTranscript([])).toBeNull();
  });
});
