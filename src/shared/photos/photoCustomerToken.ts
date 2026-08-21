import "server-only";

import { jwtVerify } from "jose";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";

export const PHOTO_CUSTOMER_TOKEN_ISSUER = "nailiq-photo-send-sms";
export const PHOTO_CUSTOMER_TOKEN_AUDIENCE = "nailiq-photo-customer";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PhotoCustomerTokenClaims = {
  photoId: string;
  salonId: string;
  phone: string;
};

export async function verifyPhotoCustomerToken(
  token: string,
): Promise<PhotoCustomerTokenClaims | null> {
  const secret = process.env.JWT_SECRET;
  if (!secret || !token.trim()) return null;
  try {
    const { payload } = await jwtVerify(
      token.trim(),
      new TextEncoder().encode(secret),
      {
        issuer: PHOTO_CUSTOMER_TOKEN_ISSUER,
        audience: PHOTO_CUSTOMER_TOKEN_AUDIENCE,
      },
    );
    const photoId = typeof payload.photo_id === "string" ? payload.photo_id : "";
    const salonId = typeof payload.salon_id === "string" ? payload.salon_id : "";
    const phone = toCanonicalPhone(
      typeof payload.client_phone === "string" ? payload.client_phone : "",
    );
    if (!UUID_RE.test(photoId) || !UUID_RE.test(salonId) || !phone) return null;
    return { photoId, salonId, phone };
  } catch {
    return null;
  }
}
