import { parsePendingGroupCreate, readPendingGroupCreate } from "./pendingGroupCreate";
import { runBoundedPublicBookingRpc } from "./publicBookingRpcBoundary";
export type PendingBookingCreate = {
  kind: "individual" | "sequence";
  salonId: string;
  idempotencyKey: string;
  pricingFingerprint: string;
};
export function parsePendingBookingCreate(hash: string): PendingBookingCreate | null {
  const match = /^#booking=(individual|sequence)\.(.+)$/.exec(hash);
  if (!match) return null;
  const binding = parsePendingGroupCreate(`#group=${match[2]}`);
  return binding ? { ...binding, kind: match[1] as PendingBookingCreate["kind"] } : null;
}
export function pendingBookingCreateHref(binding: PendingBookingCreate): string | null {
  const hash = `#booking=${binding.kind}.${binding.salonId}.${binding.idempotencyKey}.${binding.pricingFingerprint}`;
  return parsePendingBookingCreate(hash) ? `/booking/recover-booking${hash}` : null;
}
const key = (salonId: string) => `nq-pending-booking-create:${salonId}`;
export function readPendingBookingCreate(storage: Storage, salonId: string): string | null {
  const href = storage.getItem(key(salonId));
  if (!href?.startsWith("/booking/recover-booking#")) return null;
  const binding = parsePendingBookingCreate(href.slice("/booking/recover-booking".length));
  return binding?.salonId === salonId ? pendingBookingCreateHref(binding) : null;
}
export function clearPendingBookingCreate(storage: Storage, binding: PendingBookingCreate) {
  if (readPendingBookingCreate(storage, binding.salonId) === pendingBookingCreateHref(binding)) storage.removeItem(key(binding.salonId));
}
export class BookingCreateOutcomeUnknownError extends Error {
  constructor(readonly recoveryHref: string) { super("booking_commit_unknown"); }
}
export class BookingCreateRecoveryUnavailableError extends Error {
  constructor() { super("booking_recovery_unavailable"); }
}
/** Persist only opaque authority before dispatch. Never persist or replay the create payload. */
export async function dispatchPendingBookingCreate<T>(args: {
  binding: PendingBookingCreate;
  invoke: (signal: AbortSignal) => PromiseLike<T>;
  classify: (value: T) => "succeeded" | "rejected" | "unknown";
  storage?: Storage;
}): Promise<T> {
  const href = pendingBookingCreateHref(args.binding);
  if (!href) throw new BookingCreateRecoveryUnavailableError();
  let storage: Storage;
  let existing: string | null;
  try {
    storage = args.storage ?? window.sessionStorage;
    existing = readPendingBookingCreate(storage, args.binding.salonId) ?? readPendingGroupCreate(storage, args.binding.salonId);
    if (!existing) {
      storage.setItem(key(args.binding.salonId), href);
      if (readPendingBookingCreate(storage, args.binding.salonId) !== href) throw new Error("storage");
    }
  } catch { throw new BookingCreateRecoveryUnavailableError(); }
  if (existing) throw new BookingCreateOutcomeUnknownError(existing);
  try {
    const attempt = await runBoundedPublicBookingRpc({ requestId: args.binding.idempotencyKey, invoke: (_, signal) => args.invoke(signal) });
    if (attempt.kind !== "completed" || args.classify(attempt.value) === "unknown") throw new BookingCreateOutcomeUnknownError(href);
    try { clearPendingBookingCreate(storage, args.binding); } catch { /* Keep conservative authority when cleanup is unavailable. */ }
    return attempt.value;
  } catch { throw new BookingCreateOutcomeUnknownError(href); }
}
/** These responses prove a rejection before commit. Ambiguous conflicts are intentionally excluded. */
export const DEFINITE_CREATE_REJECTIONS = new Set([
  "invalid_request", "forbidden", "rate_limited", "otp_required", "invalid_otp_session", "otp_session_used", "otp_not_required", "phone_verification_required",
  "health_ack_required", "payment_not_supported", "pricing_changed", "slot_conflict", "monthly_booking_limit_reached",
]);
