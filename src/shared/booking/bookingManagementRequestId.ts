type ManagementIntent = {
  action: "confirm" | "reschedule" | "cancel" | "waitlist_claim" | "card_manage";
  token: string;
  material?: string;
};

const REQUEST_ID_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function parseStoredRequest(value: string | null): { requestId: string; createdAt: number } | null {
  try {
    const parsed = JSON.parse(value ?? "null") as { requestId?: unknown; createdAt?: unknown } | null;
    if (!parsed || typeof parsed.requestId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.requestId) ||
        typeof parsed.createdAt !== "number" || !Number.isFinite(parsed.createdAt)) return null;
    return { requestId: parsed.requestId, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

async function storageKey(intent: ManagementIntent): Promise<string> {
  const canonical = JSON.stringify({
    v: 1,
    action: intent.action,
    token: intent.token,
    material: intent.material ?? "",
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `nailiq:booking-management:${hex}`;
}

async function pendingKey(intent: Pick<ManagementIntent, "action" | "token">): Promise<string> {
  const canonical = JSON.stringify({ v: 1, action: intent.action, token: intent.token });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `nailiq:booking-management-pending:${hex}`;
}

export async function stableBookingManagementRequestId(intent: ManagementIntent): Promise<string> {
  const key = await storageKey(intent);
  const now = Date.now();
  const stored = parseStoredRequest(sessionStorage.getItem(key));
  const current = stored && now - stored.createdAt <= REQUEST_ID_MAX_AGE_MS ? stored : null;
  const requestId = current?.requestId ?? crypto.randomUUID();
  const createdAt = current?.createdAt ?? now;
  sessionStorage.setItem(key, JSON.stringify({ requestId, createdAt }));
  sessionStorage.setItem(await pendingKey(intent), JSON.stringify({
    requestId,
    material: intent.material ?? "",
    createdAt,
  }));
  return requestId;
}

export async function existingBookingManagementRequestId(intent: ManagementIntent): Promise<string | null> {
  const key = await storageKey(intent);
  const stored = parseStoredRequest(sessionStorage.getItem(key));
  if (!stored || Date.now() - stored.createdAt > REQUEST_ID_MAX_AGE_MS) {
    // Purge only stale local replay metadata. Unknown outcomes remain replayable
    // for the full bounded window and are never cleared merely by a network error.
    sessionStorage.removeItem(key);
    sessionStorage.removeItem(await pendingKey(intent));
    return null;
  }
  return stored.requestId;
}

export async function acknowledgeBookingManagementRequest(intent: ManagementIntent): Promise<void> {
  const exact = await existingBookingManagementRequestId(intent);
  sessionStorage.removeItem(await storageKey(intent));
  const indexKey = await pendingKey(intent);
  try {
    const pending = JSON.parse(sessionStorage.getItem(indexKey) ?? "null") as { requestId?: unknown } | null;
    if (!pending || !exact || pending.requestId === exact) sessionStorage.removeItem(indexKey);
  } catch {
    sessionStorage.removeItem(indexKey);
  }
}

export async function pendingBookingManagementRequest(
  intent: Pick<ManagementIntent, "action" | "token">,
): Promise<{ requestId: string; material: string } | null> {
  try {
    const key = await pendingKey(intent);
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null") as
      | { requestId?: unknown; material?: unknown; createdAt?: unknown }
      | null;
    if (value && typeof value.createdAt === "number" &&
        Date.now() - value.createdAt > REQUEST_ID_MAX_AGE_MS) {
      sessionStorage.removeItem(key);
      return null;
    }
    return value && typeof value.requestId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId) &&
      typeof value.material === "string" && typeof value.createdAt === "number"
      ? { requestId: value.requestId, material: value.material }
      : null;
  } catch {
    return null;
  }
}

/**
 * Promotes a two-stage management intent (for example sequence quote ->
 * explicit confirm) without rotating its logical request ID. The existing
 * pending record must already own that ID, so arbitrary browser material
 * cannot graft itself onto a different operation.
 */
export async function replacePendingBookingManagementRequestMaterial(
  input: ManagementIntent & { requestId: string; previousMaterial?: string },
): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(input.requestId)) return false;
  const indexKey = await pendingKey(input);
  try {
    const pending = JSON.parse(sessionStorage.getItem(indexKey) ?? "null") as
      | { requestId?: unknown; createdAt?: unknown }
      | null;
    if (
      !pending || pending.requestId !== input.requestId ||
      typeof pending.createdAt !== "number" ||
      Date.now() - pending.createdAt > REQUEST_ID_MAX_AGE_MS
    ) return false;
    if (input.previousMaterial != null) {
      sessionStorage.removeItem(await storageKey({
        action: input.action,
        token: input.token,
        material: input.previousMaterial,
      }));
    }
    sessionStorage.setItem(await storageKey(input), JSON.stringify({
      requestId: input.requestId,
      createdAt: pending.createdAt,
    }));
    sessionStorage.setItem(indexKey, JSON.stringify({
      requestId: input.requestId,
      material: input.material ?? "",
      createdAt: pending.createdAt,
    }));
    return true;
  } catch {
    return false;
  }
}

export async function replayExistingBookingManagementRequest<T>(
  intent: ManagementIntent,
  execute: (requestId: string) => Promise<{ acknowledged: boolean; value: T }>,
): Promise<{ requestId: string; value: T } | null> {
  const requestId = await existingBookingManagementRequestId(intent);
  if (!requestId) return null;
  const outcome = await execute(requestId);
  if (outcome.acknowledged) await acknowledgeBookingManagementRequest(intent);
  return { requestId, value: outcome.value };
}
