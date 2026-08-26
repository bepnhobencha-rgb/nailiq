import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const PASSWORD_RECOVERY_COOKIE = "nq-password-recovery";
export const PASSWORD_RECOVERY_MAX_AGE_SECONDS = 15 * 60;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RecoveryCapability = {
  v: 1;
  sub: string;
  sid: string;
  exp: number;
  nonce: string;
};

type RecoveryIntent = {
  v: 1;
  surface: "salon" | "superadmin";
  email: string;
  exp: number;
  nonce: string;
};

function signingSecret(): string {
  const value = process.env.PASSWORD_RECOVERY_SIGNING_SECRET?.trim();
  if (!value || value.length < 32) {
    throw new Error("password_recovery_signing_secret_unavailable");
  }
  return value;
}

function mac(payload: string): string {
  return createHmac("sha256", signingSecret()).update(payload).digest("base64url");
}

export function isPasswordRecoverySecurityConfigured(): boolean {
  try {
    void signingSecret();
    return true;
  } catch {
    return false;
  }
}

export function canonicalPasswordResetEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

export function isAcceptableRecoveryPassword(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= PASSWORD_MIN_LENGTH &&
    value.length <= PASSWORD_MAX_LENGTH &&
    !value.includes("\0")
  );
}

/**
 * Password-reset mail may only return to the fixed recovery route on the
 * configured canonical app origin. A missing or malformed origin fails closed;
 * request handlers never accept a caller-provided redirect.
 */
export function passwordRecoveryRedirectUrl(
  surface?: "salon" | "superadmin",
  recoveryIntent?: string,
): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!raw) throw new Error("password_recovery_origin_unavailable");

  const parsed = new URL(raw);
  const localHttp =
    process.env.NODE_ENV !== "production" &&
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new Error("password_recovery_origin_invalid");
  }
  if (
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("password_recovery_origin_invalid");
  }
  const recovery = new URL("/auth/recovery", parsed.origin);
  if (surface) recovery.searchParams.set("surface", surface);
  if (recoveryIntent) {
    if (!surface || recoveryIntent.length > 2_048) {
      throw new Error("password_recovery_intent_invalid");
    }
    recovery.searchParams.set("state", recoveryIntent);
  }
  return recovery.toString();
}

export function passwordRecoveryDestination(
  path:
    | "/login/forgot-password"
    | "/login/reset-password"
    | "/superadmin/forgot-password"
    | "/superadmin/reset-password",
  notice?: "invalid_or_expired" | "temporarily_unavailable",
): URL {
  const destination = new URL(path, passwordRecoveryRedirectUrl());
  if (notice) destination.searchParams.set("notice", notice);
  return destination;
}

export function sessionIdFromAccessToken(accessToken: unknown): string | null {
  if (typeof accessToken !== "string" || accessToken.length > 16_384) return null;
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      session_id?: unknown;
    };
    return typeof payload.session_id === "string" && UUID_RE.test(payload.session_id)
      ? payload.session_id.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

export function issuePasswordRecoveryIntent(input: {
  email: string;
  surface: "salon" | "superadmin";
  nowSeconds?: number;
}): string {
  const email = canonicalPasswordResetEmail(input.email);
  if (!email) throw new Error("password_recovery_intent_invalid");
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const claim: RecoveryIntent = {
    v: 1,
    surface: input.surface,
    email: createHmac("sha256", signingSecret())
      .update(`email:${email}`)
      .digest("base64url"),
    exp: now + 60 * 60,
    nonce: randomBytes(16).toString("base64url"),
  };
  const payload = Buffer.from(JSON.stringify(claim)).toString("base64url");
  return `${payload}.${mac(payload)}`;
}

export function verifyPasswordRecoveryIntent(input: {
  token: unknown;
  surface: "salon" | "superadmin";
  email?: string | null;
  nowSeconds?: number;
}): boolean {
  if (typeof input.token !== "string" || input.token.length > 2_048) return false;
  const [payload, supplied, extra] = input.token.split(".");
  if (!payload || !supplied || extra) return false;
  try {
    const expected = Buffer.from(mac(payload));
    const actual = Buffer.from(supplied);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return false;
    }
    const claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as
      Partial<RecoveryIntent>;
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (
      claim.v !== 1 ||
      claim.surface !== input.surface ||
      typeof claim.email !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(claim.email) ||
      typeof claim.exp !== "number" ||
      !Number.isSafeInteger(claim.exp) ||
      claim.exp <= now ||
      claim.exp > now + 60 * 60 ||
      typeof claim.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{20,64}$/.test(claim.nonce)
    ) {
      return false;
    }
    if (input.email == null) return true;
    const email = canonicalPasswordResetEmail(input.email);
    if (!email) return false;
    const emailBinding = createHmac("sha256", signingSecret())
      .update(`email:${email}`)
      .digest("base64url");
    const actualEmail = Buffer.from(claim.email);
    const expectedEmail = Buffer.from(emailBinding);
    return (
      actualEmail.length === expectedEmail.length &&
      timingSafeEqual(actualEmail, expectedEmail)
    );
  } catch {
    return false;
  }
}

export function issuePasswordRecoveryCapability(input: {
  userId: string;
  sessionId: string;
  nowSeconds?: number;
}): string {
  if (!UUID_RE.test(input.userId) || !UUID_RE.test(input.sessionId)) {
    throw new Error("password_recovery_binding_invalid");
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const claim: RecoveryCapability = {
    v: 1,
    sub: input.userId.toLowerCase(),
    sid: input.sessionId.toLowerCase(),
    exp: now + PASSWORD_RECOVERY_MAX_AGE_SECONDS,
    nonce: randomBytes(16).toString("base64url"),
  };
  const payload = Buffer.from(JSON.stringify(claim)).toString("base64url");
  return `${payload}.${mac(payload)}`;
}

export function verifyPasswordRecoveryCapability(input: {
  token: unknown;
  userId: string;
  sessionId: string;
  nowSeconds?: number;
}): boolean {
  if (
    typeof input.token !== "string" ||
    input.token.length > 2_048 ||
    !UUID_RE.test(input.userId) ||
    !UUID_RE.test(input.sessionId)
  ) {
    return false;
  }
  const [payload, supplied, extra] = input.token.split(".");
  if (!payload || !supplied || extra) return false;
  try {
    const expected = Buffer.from(mac(payload));
    const actual = Buffer.from(supplied);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return false;
    }
    const claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as
      Partial<RecoveryCapability>;
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    return (
      claim.v === 1 &&
      claim.sub === input.userId.toLowerCase() &&
      claim.sid === input.sessionId.toLowerCase() &&
      typeof claim.exp === "number" &&
      Number.isSafeInteger(claim.exp) &&
      claim.exp > now &&
      claim.exp <= now + PASSWORD_RECOVERY_MAX_AGE_SECONDS &&
      typeof claim.nonce === "string" &&
      /^[A-Za-z0-9_-]{20,64}$/.test(claim.nonce)
    );
  } catch {
    return false;
  }
}
