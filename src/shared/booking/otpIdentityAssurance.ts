/** Server-issued delivery proof. Email and staff attestation permit a new
 * booking, but neither proves ownership of the submitted phone number. */
export type BookingOtpVerifiedChannel =
  | "sms"
  | "email"
  | "staff_attested"
  | "demo"
  | "legacy_unverified";

export function hasActivePhoneOwnershipProof(
  session: {
    verified_channel?: unknown;
    consumed_at?: unknown;
    expires_at?: unknown;
  } | null | undefined,
  now = Date.now(),
): boolean {
  if (
    session?.verified_channel !== "sms" ||
    session.consumed_at !== null ||
    typeof session.expires_at !== "string"
  ) return false;
  const expiresAt = Date.parse(session.expires_at);
  return Number.isFinite(expiresAt) && expiresAt > now;
}
