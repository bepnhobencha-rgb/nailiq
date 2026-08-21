import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  PHOTO_CUSTOMER_TOKEN_AUDIENCE,
  PHOTO_CUSTOMER_TOKEN_ISSUER,
  verifyPhotoCustomerToken,
} from "./photoCustomerToken";

const photoId = "11111111-1111-4111-8111-111111111111";
const salonId = "22222222-2222-4222-8222-222222222222";
const secret = "test-secret-long-enough-for-hmac";

async function token(input?: { audience?: string; issuer?: string; expires?: string }) {
  return new SignJWT({ photo_id: photoId, salon_id: salonId, client_phone: "+1 604 555 0199" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(input?.issuer ?? PHOTO_CUSTOMER_TOKEN_ISSUER)
    .setAudience(input?.audience ?? PHOTO_CUSTOMER_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(input?.expires ?? "10m")
    .sign(new TextEncoder().encode(secret));
}

describe("photo customer bearer", () => {
  beforeEach(() => {
    vi.stubEnv("JWT_SECRET", secret);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns exact normalized tenant-bound claims", async () => {
    await expect(verifyPhotoCustomerToken(await token())).resolves.toEqual({
      photoId,
      salonId,
      phone: "16045550199",
    });
  });

  it.each([
    { audience: "another-purpose" },
    { issuer: "another-issuer" },
    { expires: "-1s" },
  ] as const)("rejects invalid-purpose or expired tokens", async (options) => {
    await expect(verifyPhotoCustomerToken(await token(options))).resolves.toBeNull();
  });

  it("rejects malformed tokens", async () => {
    await expect(verifyPhotoCustomerToken("not-a-jwt")).resolves.toBeNull();
  });
});
