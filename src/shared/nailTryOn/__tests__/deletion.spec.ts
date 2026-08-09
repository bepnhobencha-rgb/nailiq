import { describe, expect, it } from "vitest";
import { nailTryOnDeletionPaths } from "../deletion";

describe("Nail Try-On deletion paths", () => {
  it("includes the source and deterministic preview while generation may be in flight", () => {
    expect(nailTryOnDeletionPaths({
      salonId: "salon-1",
      sessionId: "session-1",
      sourceImagePath: "salon/salon-1/session/session-1/original.jpg",
      resultImagePath: null,
    })).toEqual([
      "salon/salon-1/session/session-1/original.jpg",
      "salon/salon-1/session/session-1/preview.jpg",
    ]);
  });

  it("deduplicates a stored result that uses the deterministic path", () => {
    expect(nailTryOnDeletionPaths({
      salonId: "salon-1",
      sessionId: "session-1",
      sourceImagePath: "salon/salon-1/session/session-1/original.jpg",
      resultImagePath: "salon/salon-1/session/session-1/preview.jpg",
    })).toHaveLength(2);
  });
});
