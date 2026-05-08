/**
 * Walk-in queue tagging vocabulary.
 *
 * `QueueSource` is the **origin / channel** for a walk-in (online vs walk-in
 * vs instagram referral, etc.). It is distinct from the existing
 * `BookingSource` (`"appointment" | "walkin"`), which is the operational
 * shape of the row. Both can coexist on a single booking row.
 *
 * `QueuePriority` is receptionist-set urgency.
 *
 * `QueueRequestTag` is free-text quick chips (e.g. "Wants Tina"). Capped at
 * 30 characters per tag and a small array length so the queue panel stays
 * scannable.
 */

export const QUEUE_SOURCES = [
  "online",
  "walk_in",
  "instagram",
  "google",
  "phone",
  "tiktok",
  "repeat",
  "vip",
] as const;

export type QueueSource = (typeof QUEUE_SOURCES)[number];

export const QUEUE_PRIORITIES = ["high", "medium", "low"] as const;

export type QueuePriority = (typeof QUEUE_PRIORITIES)[number];

export type QueueRequestTag = string;

export const QUEUE_REQUEST_TAG_MAX_LEN = 30;
export const QUEUE_REQUEST_TAGS_MAX_COUNT = 5;

export function isQueueSource(value: unknown): value is QueueSource {
  return (
    typeof value === "string" &&
    (QUEUE_SOURCES as readonly string[]).includes(value)
  );
}

export function isQueuePriority(value: unknown): value is QueuePriority {
  return (
    typeof value === "string" &&
    (QUEUE_PRIORITIES as readonly string[]).includes(value)
  );
}

/**
 * Validates and normalizes a free-text request tag.
 * - Trims surrounding whitespace.
 * - Returns null when empty or over the max length.
 */
export function normalizeRequestTag(raw: unknown): QueueRequestTag | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > QUEUE_REQUEST_TAG_MAX_LEN) return null;
  return trimmed;
}

export function parseRequestTags(
  raw: unknown,
): QueueRequestTag[] {
  if (!Array.isArray(raw)) return [];
  const out: QueueRequestTag[] = [];
  for (const item of raw) {
    const tag = normalizeRequestTag(item);
    if (tag !== null) out.push(tag);
    if (out.length >= QUEUE_REQUEST_TAGS_MAX_COUNT) break;
  }
  return out;
}
