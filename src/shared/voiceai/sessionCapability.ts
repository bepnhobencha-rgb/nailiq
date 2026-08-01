import "server-only";
import crypto from "node:crypto";

const VERSION = "v1";

function signingSecret(): string | null {
  return (
    process.env.VOICE_SESSION_SIGNING_SECRET?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.VOICE_BRIDGE_SECRET?.trim() ||
    null
  );
}

function digest(sessionId: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${VERSION}:${sessionId}`)
    .digest("base64url");
}

/**
 * Browser-safe, session-scoped capability for the privileged end-session write.
 * The token proves only possession of this session id; it never exposes the
 * server signing secret and cannot authorize another session.
 */
export function createVoiceSessionCapability(sessionId: string): string | null {
  const secret = signingSecret();
  if (!secret || !sessionId) return null;
  return `${VERSION}.${digest(sessionId, secret)}`;
}

export function verifyVoiceSessionCapability(
  sessionId: string,
  token: string | null | undefined,
): boolean {
  const expected = createVoiceSessionCapability(sessionId);
  if (!expected || !token) return false;
  const actualBytes = Buffer.from(token);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) return false;
  return crypto.timingSafeEqual(actualBytes, expectedBytes);
}
