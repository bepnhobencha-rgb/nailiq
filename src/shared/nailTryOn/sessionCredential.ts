import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function createSessionCredential(sessionId: string) {
  const token = randomBytes(32).toString("base64url");
  return { token, cookieValue: `${sessionId}.${token}`, tokenHash: hashToken(token) };
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function verifySessionCredential(cookieValue: string | undefined, sessionId: string, storedHash: string) {
  if (!cookieValue) return false;
  const separator = cookieValue.indexOf(".");
  if (separator < 1 || cookieValue.slice(0, separator) !== sessionId) return false;
  const actual = Buffer.from(hashToken(cookieValue.slice(separator + 1)), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
