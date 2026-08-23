import "server-only";

import { createVerify } from "node:crypto";

export const MAX_WIX_WEBHOOK_BYTES = 64 * 1024;

export type ParsedWixWebhookEvent = {
  eventId: string;
  eventTime: string;
  entityFqdn: "wix.bookings.v2.booking";
  slug: "created" | "updated" | "confirmed" | "cancelled" | "canceled" | "declined";
  entityId: string;
  siteId: string;
};

const EVENT_SLUGS = new Set<ParsedWixWebhookEvent["slug"]>([
  "created", "updated", "confirmed", "cancelled", "canceled", "declined",
]);
const BOUNDED_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const BASE64_SIGNATURE_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function readWixWebhookBody(
  request: Request,
): Promise<{ ok: true; bytes: Uint8Array; text: string } | { ok: false; code: string }> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_WIX_WEBHOOK_BYTES) {
      return { ok: false, code: "body_too_large" };
    }
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, code: "invalid_body" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_WIX_WEBHOOK_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, code: "body_too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, code: "invalid_body" };
  }
  if (total < 1) return { ok: false, code: "invalid_body" };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, bytes, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, code: "invalid_body" };
  }
}

export function parseWixWebhookEvent(
  text: string,
  headerSiteId: string | null,
): ParsedWixWebhookEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const body = record(parsed);
  if (!body || record(body.data)) return null;
  const entityFqdn = body.entityFqdn;
  const eventId = body.id;
  const eventTime = body.eventTime;
  const slug = body.slug;
  const entityId = body.entityId;
  const bodySiteId = body.siteId;
  const siteId = headerSiteId?.trim() ?? "";
  if (
    typeof eventId !== "string" ||
    !BOUNDED_ID_RE.test(eventId) ||
    typeof eventTime !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(eventTime) ||
    !Number.isFinite(Date.parse(eventTime)) ||
    entityFqdn !== "wix.bookings.v2.booking" ||
    typeof slug !== "string" ||
    !EVENT_SLUGS.has(slug as ParsedWixWebhookEvent["slug"]) ||
    typeof entityId !== "string" ||
    !BOUNDED_ID_RE.test(entityId) ||
    !BOUNDED_ID_RE.test(siteId) ||
    (bodySiteId != null && bodySiteId !== siteId) ||
    (body.data != null && typeof body.data !== "string") ||
    (typeof body.data === "string" && body.data.length > 48 * 1024)
  ) {
    return null;
  }
  return {
    eventId,
    eventTime,
    entityFqdn,
    slug: slug as ParsedWixWebhookEvent["slug"],
    entityId,
    siteId,
  };
}

export function verifyWixWebhookSignature(input: {
  publicKeyPem: string;
  bytes: Uint8Array;
  signatureHeader: string | null;
}): boolean {
  const signature = input.signatureHeader?.trim() ?? "";
  const key = input.publicKeyPem.trim();
  if (
    key.length < 64 || key.length > 8_192 ||
    signature.length < 16 || signature.length > 2_048 ||
    !BASE64_SIGNATURE_RE.test(signature)
  ) return false;
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(input.bytes);
    verifier.end();
    return verifier.verify(key, signature, "base64");
  } catch {
    return false;
  }
}
