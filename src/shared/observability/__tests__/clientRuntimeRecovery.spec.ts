import { describe, expect, it } from "vitest";

import {
  decideHistoryRateLimitRecovery,
  isHistoryReplaceStateRateLimitError,
} from "../clientRuntimeRecovery";

const SAFARI_HISTORY_ERROR =
  "SecurityError: Attempt to use history.replaceState() more than 100 times per 10 seconds";

describe("client runtime recovery", () => {
  it("recognizes the Safari history rate-limit failure", () => {
    expect(isHistoryReplaceStateRateLimitError(SAFARI_HISTORY_ERROR)).toBe(true);
    expect(
      isHistoryReplaceStateRateLimitError(
        "SecurityError: Failed to execute history.replaceState()",
      ),
    ).toBe(false);
  });

  it("allows one recovery reload", () => {
    expect(decideHistoryRateLimitRecovery(SAFARI_HISTORY_ERROR, null, 50_000)).toBe(
      "reload",
    );
  });

  it("guards against a reload loop when the same fault immediately returns", () => {
    expect(
      decideHistoryRateLimitRecovery(SAFARI_HISTORY_ERROR, "45000", 50_000),
    ).toBe("guarded");
  });

  it("allows a later independent incident to recover", () => {
    expect(
      decideHistoryRateLimitRecovery(SAFARI_HISTORY_ERROR, "10000", 50_000),
    ).toBe("reload");
  });

  it("does not interfere with unrelated client errors", () => {
    expect(decideHistoryRateLimitRecovery("React hydration failed", null, 50_000)).toBe(
      null,
    );
  });
});
