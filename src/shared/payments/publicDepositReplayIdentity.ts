export type PublicDepositReplayIdentity = {
  bookingRequestId: string;
  paymentRequestId: string;
  createdAt: number;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

async function storageKey(materialKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`nailiq:public-deposit:v1:${materialKey}`),
  );
  const hex = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `nailiq:public-deposit:${hex}`;
}

function parse(value: string | null): PublicDepositReplayIdentity | null {
  try {
    const row = JSON.parse(value ?? "null") as Record<string, unknown> | null;
    return row && UUID_RE.test(String(row.bookingRequestId ?? "")) &&
      UUID_RE.test(String(row.paymentRequestId ?? "")) &&
      typeof row.createdAt === "number" && Number.isFinite(row.createdAt)
      ? {
          bookingRequestId: String(row.bookingRequestId),
          paymentRequestId: String(row.paymentRequestId),
          createdAt: row.createdAt,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * Keeps the exact booking/payment operation identity through refresh and
 * response loss. `materialKey` must contain only non-PII canonical booking
 * facts (IDs, UTC interval and the authoritative pricing fingerprint).
 */
export async function stablePublicDepositReplayIdentity(
  materialKey: string,
  bookingRequestId?: string,
): Promise<PublicDepositReplayIdentity> {
  if (!materialKey || materialKey.length > 4096) {
    throw new Error("invalid_public_deposit_material_key");
  }
  if (bookingRequestId !== undefined && !UUID_RE.test(bookingRequestId)) {
    throw new Error("invalid_public_deposit_booking_request_id");
  }
  const key = await storageKey(materialKey);
  const now = Date.now();
  const stored = parse(sessionStorage.getItem(key));
  if (
    stored && now - stored.createdAt <= MAX_AGE_MS &&
    (bookingRequestId === undefined || stored.bookingRequestId === bookingRequestId)
  ) return stored;
  const created = {
    bookingRequestId: bookingRequestId ?? crypto.randomUUID(),
    paymentRequestId: crypto.randomUUID(),
    createdAt: now,
  };
  sessionStorage.setItem(key, JSON.stringify(created));
  return created;
}

export async function acknowledgePublicDepositReplayIdentity(
  materialKey: string,
): Promise<void> {
  sessionStorage.removeItem(await storageKey(materialKey));
}
