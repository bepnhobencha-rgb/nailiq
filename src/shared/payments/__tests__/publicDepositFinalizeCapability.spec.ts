import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  derivePublicDepositFinalizeToken,
  verifyPublicDepositFinalizeToken,
} from "../publicDepositFinalizeCapability";

const operationId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";

describe("public deposit finalize capability", () => {
  beforeEach(() => {
    vi.stubEnv("BOOKING_DEPOSIT_FINALIZE_SECRET", "local-only-test-secret");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("is deterministic for response-loss replay and bound to the exact request", () => {
    const first = derivePublicDepositFinalizeToken(operationId, requestId);
    expect(derivePublicDepositFinalizeToken(operationId, requestId)).toBe(first);
    expect(verifyPublicDepositFinalizeToken(first, operationId, requestId)).toBe(true);
    expect(verifyPublicDepositFinalizeToken(
      first,
      operationId,
      "55555555-5555-4555-8555-555555555555",
    )).toBe(false);
  });

  it("fails closed without a signing secret", () => {
    vi.stubEnv("BOOKING_DEPOSIT_FINALIZE_SECRET", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(() => derivePublicDepositFinalizeToken(operationId, requestId))
      .toThrow("deposit_finalize_signing_unavailable");
  });
});
