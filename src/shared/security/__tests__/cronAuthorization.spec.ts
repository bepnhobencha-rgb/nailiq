import { describe, expect, it } from "vitest";

import { requireCronAuthorization } from "../cronAuthorization";

function request(authorization?: string) {
  return new Request("https://nailiq.ca/api/cron/example", {
    headers: authorization ? { authorization } : undefined,
  });
}

describe("requireCronAuthorization", () => {
  it.each([undefined, "", "   "])(
    "fails closed when the configured secret is %j",
    async (secret) => {
      const response = requireCronAuthorization(request(), secret);

      expect(response?.status).toBe(503);
      expect(await response?.json()).toEqual({
        ok: false,
        error: "cron_secret_not_configured",
      });
    },
  );

  it.each([
    undefined,
    "",
    "secret",
    "bearer secret",
    "Bearer",
    "Bearer  secret",
    "Basic secret",
  ])("rejects the non-exact Authorization value %j", async (authorization) => {
    const response = requireCronAuthorization(
      request(authorization),
      "secret",
    );

    expect(response?.status).toBe(401);
    expect(await response?.json()).toEqual({
      ok: false,
      error: "unauthorized",
    });
  });

  it("accepts only the exact Bearer credential", () => {
    expect(
      requireCronAuthorization(request("Bearer secret"), "secret"),
    ).toBeNull();
  });
});
