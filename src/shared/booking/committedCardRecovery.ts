/** Exact create receipt authority, never a provider source or customer contact. */
export type CommittedCardRecoveryBinding = {
  salonId: string;
  bookingId: string;
  idempotencyKey: string;
  pricingFingerprint: string;
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const BINDING = new RegExp(`^#recover=(${UUID})\\.(${UUID})\\.(${UUID})\\.([0-9a-f]{64})$`, "i");
const TOKEN = new RegExp(`^${UUID}$`, "i");

export function parseCommittedCardRecovery(hash: string): CommittedCardRecoveryBinding | null {
  const match = BINDING.exec(hash);
  return match ? { salonId: match[1], bookingId: match[2], idempotencyKey: match[3], pricingFingerprint: match[4].toLowerCase() } : null;
}

/**
 * The fragment survives reload but is not sent in HTTP URLs or Referer headers.
 * Only these four fields are carried; do not serialize the create input here.
 * This is bearer authority: never log it. The server enforces the original
 * 30-minute exchange window and tenant/create binding, not this client parser.
 */
export function committedCardRecoveryHref(binding: CommittedCardRecoveryBinding): string | null {
  const hash = `#recover=${binding.salonId}.${binding.bookingId}.${binding.idempotencyKey}.${binding.pricingFingerprint}`;
  return parseCommittedCardRecovery(hash) ? `/booking/recover-card${hash}` : null;
}

export type CommittedCardRecoveryOutcome =
  | { status: "ready"; token: string }
  | { status: "not_required"; receipt: CommittedBookingRecoveryReceipt }
  | { status: "not_applicable" | "expired" | "unavailable" };

/** Minimal verified appointment summary; no contact, card metadata or bearer authority. */
export type CommittedBookingRecoveryReceipt = {
  salonName: string;
  startTimeUtc: string;
  timezone: string;
  services: string[];
};

export function parseCommittedBookingRecoveryReceipt(value: unknown): CommittedBookingRecoveryReceipt | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.salonName !== "string" || !v.salonName.trim() || v.salonName.length > 200 ||
      typeof v.startTimeUtc !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v.startTimeUtc) || !Number.isFinite(Date.parse(v.startTimeUtc)) ||
      typeof v.timezone !== "string" || !Array.isArray(v.services) || !v.services.length || v.services.length > 20 ||
      !v.services.every((s) => typeof s === "string" && s.trim() && s.length <= 200)) return null;
  try { new Intl.DateTimeFormat("en", { timeZone: v.timezone }).format(0); } catch { return null; }
  return { salonName: v.salonName, startTimeUtc: v.startTimeUtc, timezone: v.timezone, services: v.services as string[] };
}

/** One capability exchange only. Never create a booking/customer/card or replay a source. */
export async function recoverCommittedCardCapability(
  binding: CommittedCardRecoveryBinding,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<CommittedCardRecoveryOutcome> {
  if (!committedCardRecoveryHref(binding)) return { status: "expired" };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async (): Promise<CommittedCardRecoveryOutcome> => {
        const response = await fetcher("/api/booking/card-capability", {
          method: "POST", headers: { "Content-Type": "application/json" },
          cache: "no-store", signal: controller.signal,
          body: JSON.stringify({ salonId: binding.salonId, bookingId: binding.bookingId,
            idempotencyKey: binding.idempotencyKey, pricingFingerprint: binding.pricingFingerprint, includeReceipt: true }),
        });
        const value = await response.json().catch(() => null);
        if ([400, 404].includes(response.status) &&
            ["invalid_request", "create_binding_invalid", "exchange_expired"].includes(value?.code)) return { status: "expired" };
        if (!response.ok || value?.ok !== true) return { status: "unavailable" };
        if (value.required === false) {
          // A release flag alone does not establish that this booking exists.
          if (value.cardManagementStatus === "not_applicable") return { status: "not_applicable" };
          const receipt = parseCommittedBookingRecoveryReceipt(value.receipt);
          return receipt ? { status: "not_required", receipt } : { status: "unavailable" };
        }
        return value.required === true && typeof value.token === "string" && TOKEN.test(value.token)
          ? { status: "ready", token: value.token } : { status: "unavailable" };
      })(),
      new Promise<CommittedCardRecoveryOutcome>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve({ status: "unavailable" }); }, 5_000);
      }),
    ]);
  } catch {
    return { status: "unavailable" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
