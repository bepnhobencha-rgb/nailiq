export type PublicBookingRequestMaterial = {
  salonId: string;
  serviceId: string;
  staffId: string;
  clientName: string;
  clientPhone: string;
  startTimeUtc: string;
  endTimeUtc: string;
  clientNotes: string | null;
  addonServiceIds: readonly string[];
  clientEmail: string | null;
  resourceId: string | null;
  comboId: string | null;
  voucherId: string | null;
  applyEmailDiscount: boolean;
  expectedPricingFingerprint: string;
};

type LocalStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type CrossTabLockManager = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

type RequestIdOptions = {
  storage?: LocalStorageLike | null;
  locks?: CrossTabLockManager | null;
  now?: number;
  newId?: () => string;
};

const REQUEST_ID_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const STORAGE_PREFIX = "nailiq:public-booking-request:v2";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function browserLocalStorage(): LocalStorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function browserLockManager(): CrossTabLockManager | null {
  if (typeof navigator === "undefined") return null;
  const locks = (navigator as Navigator & { locks?: unknown }).locks;
  if (!locks || typeof (locks as { request?: unknown }).request !== "function") {
    return null;
  }
  return locks as CrossTabLockManager;
}

function canonicalMaterial(material: PublicBookingRequestMaterial): string {
  return JSON.stringify({
    v: 2,
    salon_id: material.salonId,
    service_id: material.serviceId,
    staff_id: material.staffId,
    client_name: material.clientName.trim(),
    client_phone: material.clientPhone.replace(/\D/g, ""),
    start_time_utc: material.startTimeUtc,
    end_time_utc: material.endTimeUtc,
    status: "confirmed",
    client_notes: material.clientNotes?.trim() || null,
    addon_service_ids: [...material.addonServiceIds],
    client_email: material.clientEmail?.trim().toLowerCase() || null,
    resource_id: material.resourceId,
    combo_id: material.comboId,
    voucher_id: material.voucherId,
    apply_email_discount: material.applyEmailDiscount,
    expected_pricing_fingerprint: material.expectedPricingFingerprint,
  });
}

async function materialDigest(material: PublicBookingRequestMaterial): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalMaterial(material)),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function parseStoredRequest(
  value: string | null,
): { requestId: string; createdAt: number } | null {
  try {
    const parsed = JSON.parse(value ?? "null") as Record<string, unknown> | null;
    if (
      !parsed ||
      !UUID_RE.test(String(parsed.requestId ?? "")) ||
      typeof parsed.createdAt !== "number" ||
      !Number.isFinite(parsed.createdAt)
    ) return null;
    return {
      requestId: String(parsed.requestId),
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

function freshRequestId(options?: RequestIdOptions): string {
  const requestId = options?.newId ? options.newId() : crypto.randomUUID();
  if (!UUID_RE.test(requestId)) throw new Error("invalid_public_booking_request_id");
  return requestId;
}

function resolveStorage(options?: RequestIdOptions): LocalStorageLike | null {
  return options?.storage === undefined ? browserLocalStorage() : options.storage;
}

function resolveLocks(options?: RequestIdOptions): CrossTabLockManager | null {
  return options?.locks === undefined ? browserLockManager() : options.locks;
}

async function withMaterialLock<T>(
  digest: string,
  locks: CrossTabLockManager | null,
  action: () => Promise<T>,
): Promise<T> {
  return locks
    ? locks.request(`${STORAGE_PREFIX}:${digest}`, action)
    : action();
}

/**
 * Returns one random operation ID for one exact DB booking material envelope.
 * The material is SHA-256 hashed before becoming a localStorage/Web-Lock key;
 * only the random UUID and timestamp persist. A Web Lock serializes concurrent
 * independent tabs, while materially different bookings use different locks.
 */
export async function stablePublicBookingRequestId(
  material: PublicBookingRequestMaterial,
  options?: RequestIdOptions,
): Promise<string> {
  const storage = resolveStorage(options);
  if (!storage) return freshRequestId(options);

  const digest = await materialDigest(material);
  const key = `${STORAGE_PREFIX}:${digest}`;
  return withMaterialLock(digest, resolveLocks(options), async () => {
    const now = options?.now ?? Date.now();
    try {
      const stored = parseStoredRequest(storage.getItem(key));
      if (
        stored &&
        now >= stored.createdAt &&
        now - stored.createdAt <= REQUEST_ID_MAX_AGE_MS
      ) return stored.requestId;
    } catch {
      // A constrained browser may deny storage after it was resolved.
    }

    const requestId = freshRequestId(options);
    try {
      storage.setItem(key, JSON.stringify({ requestId, createdAt: now }));
    } catch {
      // The mounted flow still keeps this UUID in React state/ref.
    }
    return requestId;
  });
}

/** Clear only the exact acknowledged material/UUID pair after DB success. */
export async function acknowledgePublicBookingRequestId(
  material: PublicBookingRequestMaterial,
  requestId: string,
  options?: RequestIdOptions,
): Promise<void> {
  try {
    const storage = resolveStorage(options);
    if (!storage || !UUID_RE.test(requestId)) return;
    const digest = await materialDigest(material);
    const key = `${STORAGE_PREFIX}:${digest}`;
    await withMaterialLock(digest, resolveLocks(options), async () => {
      const stored = parseStoredRequest(storage.getItem(key));
      if (stored?.requestId === requestId) storage.removeItem(key);
    });
  } catch {
    // Cleanup after a committed booking is best-effort and never changes truth.
  }
}
