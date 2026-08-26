import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("public auth rate-limit boundary", () => {
  it("does not call password or email-link auth providers directly from the browser", () => {
    const client = source("src/components/auth/SocialAuthButtons.tsx");
    expect(client).not.toContain("auth.signInWithPassword");
    expect(client).not.toContain("auth.signUp");
    expect(client).not.toContain("auth.signInWithOtp");
    expect(client).toContain("authenticateWithEmailPassword");
    expect(client).toContain("sendEmailMagicLink");
  });

  it.each([
    ["src/shared/register/actions.ts", "auth-magic-link"],
    ["src/shared/auth/salonOwnerAuth.ts", "salon-password-reset"],
    ["src/shared/superadmin/superadminAuth.ts", "superadmin-password-login"],
    ["src/shared/superadmin/superadminAuth.ts", "superadmin-password-reset"],
  ])("keeps %s behind durable hashed scope %s", (path, scope) => {
    const server = source(path);
    expect(server).toContain("consumePublicServerActionRateLimit");
    expect(server).toContain(`scope: "${scope}"`);
  });

  it("covers ordinary, embedded, custom-domain, and auth proxy traffic durably", () => {
    const proxy = source("src/proxy.ts");
    expect(proxy).toContain("consumeEdgeDurableRateLimits");
    expect(proxy).toContain("isEmbedBookingPath");
    expect(proxy).toContain('consumeProxyLimit(request, "booking-page")');
    expect(proxy).toContain('consumeProxyLimit(request, "auth")');
    expect(proxy).toContain("limiterUnavailableResponse");
  });

  it("keeps auth available during a proxy limiter outage while public surfaces fail closed", () => {
    const proxy = source("src/proxy.ts");
    const authBoundary = proxy.slice(
      proxy.indexOf("if (isPublicAuthAttempt(request))"),
      proxy.indexOf("// Coarse durable abuse ceiling"),
    );
    const publicApiBoundary = proxy.slice(
      proxy.indexOf("if (isPublicApiBoundary(pathnameEarly))"),
      proxy.indexOf("let supabaseResponse"),
    );

    expect(authBoundary).toContain('durableLimit === "unavailable"');
    expect(authBoundary).toContain("console.warn");
    expect(authBoundary).not.toContain("return limiterUnavailableResponse()");
    expect(publicApiBoundary).toContain("return limiterUnavailableResponse()");
  });

  it("places a durable ceiling before every explicitly public API namespace", () => {
    const proxy = source("src/proxy.ts");

    for (const prefix of [
      "/api/ai/approve",
      "/api/booking-otp",
      "/api/booking/",
      "/api/chat/booking",
      "/api/customer/",
      "/api/errors",
      "/api/gift-card/purchase",
      "/api/nail-tryon/",
      "/api/public/salon-suggestions",
      "/api/referrals/",
      "/api/vouchers/",
      "/api/voice/",
      "/api/waitlist/",
    ]) {
      expect(proxy).toContain(JSON.stringify(prefix));
    }
    expect(proxy).toContain('consumeProxyLimit(request, "public-api")');
    expect(proxy).not.toMatch(/PUBLIC_API_RATE_LIMIT_PREFIXES[\s\S]*\/api\/webhooks/);
  });
});
