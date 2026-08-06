import { describe, expect, it } from "vitest";
import { isSuccessfulNoShowChargeStatus } from "../noshowChargeStatus";

describe("isSuccessfulNoShowChargeStatus", () => {
  it.each(["COMPLETED", "APPROVED", "succeeded", " Succeeded "])(
    "accepts a successful provider status: %s",
    (status) => {
      expect(isSuccessfulNoShowChargeStatus(status)).toBe(true);
    },
  );

  it.each(["failed", "requires_action", "processing", "", null, undefined])(
    "rejects a non-final provider status: %s",
    (status) => {
      expect(isSuccessfulNoShowChargeStatus(status)).toBe(false);
    },
  );
});
