import { afterEach, describe, expect, it, vi } from "vitest";
import { authCookieOptions } from "./authCookieOptions";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Auth cookie transport policy", () => {
  it.each([
    "https://www.nailiq.ca", "https://preview.vercel.app", "http://www.nailiq.ca",
    "https://localhost:3443", "https://127.0.0.1:3443", "http://localhost.evil.test",
    "http://localhost@evil.test", "http://user:password@localhost:3000", "not a URL", "",
  ])("requires HTTPS for %s", origin => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
    expect(authCookieOptions()).toEqual({ secure: true });
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])(
    "allows explicitly configured loopback development at %s", origin => {
      vi.stubEnv("VERCEL", "");
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
      expect(authCookieOptions()).toEqual({ secure: false });
    },
  );

  it("defaults to Secure when the deployment origin is absent", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", undefined);
    expect(authCookieOptions()).toEqual({ secure: true });
  });

  it("allows an HTTPS transport hint to strengthen local HTTP, never to downgrade HTTPS", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
    expect(authCookieOptions(true)).toEqual({ secure: true });
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.nailiq.ca");
    expect(authCookieOptions(false)).toEqual({ secure: true });
  });

  it("keeps hosted Vercel cookies Secure even if the canonical URL is misconfigured", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
    expect(authCookieOptions()).toEqual({ secure: true });
  });

  it.each(["https://www.nailiq.ca", "https://localhost:3443"])(
    "uses actual browser HTTPS at %s instead of the build's loopback origin", origin => {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
      vi.stubGlobal("window", { location: { origin } });
      expect(authCookieOptions()).toEqual({ secure: true });
    },
  );
});
