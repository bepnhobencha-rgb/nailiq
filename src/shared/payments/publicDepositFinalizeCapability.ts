import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function signingSecret(): string {
  const secret =
    process.env.BOOKING_DEPOSIT_FINALIZE_SECRET?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!secret) throw new Error("deposit_finalize_signing_unavailable");
  return secret;
}

/**
 * Deterministic opaque bearer for the exact public deposit operation/request.
 * The database stores only its SHA-256 hash. Replaying the same claim after an
 * attach response loss regenerates the same bearer; no plaintext capability is
 * persisted and a different request cannot finalize the operation.
 */
export function derivePublicDepositFinalizeToken(
  operationId: string,
  requestId: string,
): string {
  if (!UUID_RE.test(operationId) || !UUID_RE.test(requestId)) {
    throw new Error("invalid_deposit_finalize_identity");
  }
  const mac = createHmac("sha256", signingSecret())
    .update(`nailiq:public-deposit-finalize:v1:${operationId}:${requestId}`, "utf8")
    .digest("base64url");
  return `v1.${mac}`;
}

/**
 * Deterministic browser bearer for the Square customer-present second stage.
 * The database stores only its SHA-256 hash. The same operation/request pair
 * therefore survives a lost capability response without persisting plaintext.
 */
export function derivePublicSquareDepositCapabilityToken(
  operationId: string,
  requestId: string,
): string {
  if (!UUID_RE.test(operationId) || !UUID_RE.test(requestId)) {
    throw new Error("invalid_square_deposit_capability_identity");
  }
  const mac = createHmac("sha256", signingSecret())
    .update(`nailiq:public-square-deposit:v1:${operationId}:${requestId}`, "utf8")
    .digest("base64url");
  return `sq1.${mac}`;
}

export function verifyPublicDepositFinalizeToken(
  token: string,
  operationId: string,
  requestId: string,
): boolean {
  try {
    const expected = derivePublicDepositFinalizeToken(operationId, requestId);
    const providedBuffer = Buffer.from(token, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    return providedBuffer.length === expectedBuffer.length &&
      timingSafeEqual(providedBuffer, expectedBuffer);
  } catch {
    return false;
  }
}
