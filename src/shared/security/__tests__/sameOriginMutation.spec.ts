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

  it("allows the exact configured public origin behind a local reverse proxy", () => {
    const previous = process.env.NEXT_PUBLIC_SITE_URL;
    process.env.NEXT_PUBLIC_SITE_URL = "https://single-use-name.trycloudflare.com";
    try {
      const proxied = new Request("http://127.0.0.1:3000/api/booking/card-capability", {
        method: "POST",
        headers: {
          Origin: "https://single-use-name.trycloudflare.com",
          Cookie: "qa_gate=present",
          "Sec-Fetch-Site": "same-origin",
        },
      });
      expect(isSameOriginMutation(proxied)).toBe(true);

      const attacker = new Request("http://127.0.0.1:3000/api/booking/card-capability", {
        method: "POST",
        headers: {
          Origin: "https://single-use-name.trycloudflare.com.evil.example",
          Cookie: "qa_gate=present",
          "Sec-Fetch-Site": "same-origin",
        },
      });
      expect(isSameOriginMutation(attacker)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
      else process.env.NEXT_PUBLIC_SITE_URL = previous;
    }
  });
});
