import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import { safeProviderError } from "../providerError";

describe("safeProviderError", () => {
  it("classifies common provider failures", () => {
    expect(safeProviderError({ status: 401 }).code).toBe("provider_auth");
    expect(safeProviderError({ status: 403 }).code).toBe("provider_access");
    expect(safeProviderError({ status: 429 }).code).toBe("provider_rate_limit");
    expect(safeProviderError({ status: 503 }).code).toBe("provider_unavailable");
    expect(safeProviderError({ code: "ETIMEDOUT" }).code).toBe("provider_timeout");
    const timeout = new OpenAI.APIConnectionTimeoutError({
      message: "Request timed out",
    });
    expect(safeProviderError(timeout).code).toBe("provider_timeout");
  });

  it("keeps only bounded operational metadata", () => {
    expect(safeProviderError({
      status: 429,
      code: "rate_limit_exceeded",
      type: "requests",
      request_id: "req_123",
      message: "must never be copied",
      headers: { authorization: "secret" },
    })).toEqual({
      code: "provider_rate_limit",
      status: 429,
      providerCode: "rate_limit_exceeded",
      providerType: "requests",
      requestId: "req_123",
    });
  });
});
