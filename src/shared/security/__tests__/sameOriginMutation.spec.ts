import { describe, expect, it } from "vitest";

import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://nailiq.ca/api/dashboard/example", {
    method: "POST",
    headers,
  });
}

describe("cookie API same-origin mutation fence", () => {
  it("allows an exact same-origin browser mutation", () => {
    expect(isSameOriginMutation(request({
      Origin: "https://nailiq.ca",
      Cookie: "sb-access-token=secret",
      "Sec-Fetch-Site": "same-origin",
    }))).toBe(true);
  });

  it.each<Record<string, string>>([
    {},
    { Origin: "null", Cookie: "session=secret" },
    { Origin: "https://attacker.example", Cookie: "session=secret" },
    { Origin: "https://nailiq.ca.evil.example", Cookie: "session=secret" },
    { Origin: "https://nailiq.ca", Cookie: "session=secret", "Sec-Fetch-Site": "cross-site" },
    { Origin: "not a url", Cookie: "session=secret" },
  ])("rejects an unproven browser origin %#", (headers) => {
    expect(isSameOriginMutation(request(headers))).toBe(false);
  });

  it("allows only an explicitly opted-in non-cookie Bearer client", () => {
    const bearer = request({ Authorization: "Bearer signed-customer-token" });
    expect(isSameOriginMutation(bearer)).toBe(false);
    expect(isSameOriginMutation(bearer, { allowBearerWithoutCookie: true })).toBe(true);

    const mixed = request({
      Authorization: "Bearer signed-customer-token",
      Cookie: "session=ambient",
    });
    expect(isSameOriginMutation(mixed, { allowBearerWithoutCookie: true })).toBe(false);
  });
});
