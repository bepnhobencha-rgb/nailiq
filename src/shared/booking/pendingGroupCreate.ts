/** Browser recovery authority only; never persist create payload, contact, OTP or card source. */
export type PendingGroupCreate = { salonId: string; idempotencyKey: string; pricingFingerprint: string };
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const RE = new RegExp(`^#group=(${UUID})\\.(${UUID})\\.([0-9a-f]{64})$`, 'i');
export function parsePendingGroupCreate(hash: string): PendingGroupCreate | null {
  const m = RE.exec(hash);
  return m ? { salonId: m[1], idempotencyKey: m[2], pricingFingerprint: m[3].toLowerCase() } : null;
}
export function pendingGroupCreateHref(b: PendingGroupCreate): string | null {
  const hash = `#group=${b.salonId}.${b.idempotencyKey}.${b.pricingFingerprint}`;
  return parsePendingGroupCreate(hash) ? `/booking/recover-group${hash}` : null;
}
const storageKey = (salonId: string) => `nq-pending-group-create:${salonId}`;
export function readPendingGroupCreate(storage: Storage, salonId: string): string | null {
  const href = storage.getItem(storageKey(salonId));
  if (!href?.startsWith('/booking/recover-group#')) return null;
  const b = parsePendingGroupCreate(href.slice('/booking/recover-group'.length));
  return b?.salonId === salonId ? pendingGroupCreateHref(b) : null;
}
export function clearPendingGroupCreate(storage: Storage, b: PendingGroupCreate) {
  if (readPendingGroupCreate(storage, b.salonId) === pendingGroupCreateHref(b)) storage.removeItem(storageKey(b.salonId));
}
export type GroupCreateDispatchResult =
  | { status: 'response'; response: Response; body: Record<string, unknown> }
  | { status: 'unknown'; recoveryHref: string }
  | { status: 'storage_unavailable' };
const DEFINITE_REJECTIONS = new Set(['invalid_request','forbidden','rate_limited','otp_required','otp_invalid','pricing_changed','slot_conflict','voucher_invalid','monthly_booking_limit_reached']);
export async function dispatchGroupCreate(
  binding: PendingGroupCreate, body: unknown, storage: Storage, fetcher: typeof fetch = fetch,
): Promise<GroupCreateDispatchResult> {
  const href = pendingGroupCreateHref(binding);
  if (!href) return { status: 'storage_unavailable' };
  try {
    const existing = readPendingGroupCreate(storage, binding.salonId);
    if (existing) return { status: 'unknown', recoveryHref: existing };
    storage.setItem(storageKey(binding.salonId), href);
    if (readPendingGroupCreate(storage, binding.salonId) !== href) return { status: 'storage_unavailable' };
  } catch { return { status: 'storage_unavailable' }; }
  const unknown = { status: 'unknown', recoveryHref: href } as const;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async (): Promise<GroupCreateDispatchResult> => {
        const response = await fetcher('/api/booking/group-create', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: controller.signal,
        });
        const value = await response.json().catch(() => null);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown;
        if (response.ok && value.ok === true) return { status: 'response', response, body: value };
        if (response.status >= 400 && response.status < 500 && value.ok === false && DEFINITE_REJECTIONS.has(value.code)) {
          clearPendingGroupCreate(storage, binding);
          return { status: 'response', response, body: value };
        }
        return unknown;
      })(),
      new Promise<GroupCreateDispatchResult>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(unknown); }, 12_000);
      }),
    ]);
  } catch { return unknown; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
