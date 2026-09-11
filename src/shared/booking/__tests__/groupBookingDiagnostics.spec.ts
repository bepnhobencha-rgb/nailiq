import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { logGroupBookingFailure } from "../groupBookingDiagnostics";

describe("group booking safe diagnostic vocabulary", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());
  it("preserves allowlisted database failure codes without request metadata", () => {
    logGroupBookingFailure("pricing_read", "dependency_error", "57014");
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
      event: "group_booking_dependency_failure", stage: "pricing_read", outcome: "dependency_error", code: "57014",
    }));
  });
  it.each(["private@example.test", "source=private-token", { message: "private response" }, null])(
    "never serializes an untrusted error value", (value) => {
      logGroupBookingFailure("voucher_read", "dependency_exception", value);
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
        event: "group_booking_dependency_failure", stage: "voucher_read", outcome: "dependency_exception", code: "unclassified",
      }));
    },
  );
  it("does not throw if the sink fails", () => {
    vi.mocked(console.warn).mockImplementation(() => { throw new Error("sink unavailable"); });
    expect(() => logGroupBookingFailure("pricing_read", "dependency_exception")).not.toThrow();
  });
});
