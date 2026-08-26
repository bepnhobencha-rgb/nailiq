const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A local-only, one-way identity binding for sequence draft recovery. The
 * phone itself is never stored in the key or payload; changing identity cannot
 * recover or reuse the previous request ID.
 */
export async function bookingSequenceDraftStorageKey(args: {
  salonId: string;
  phone: string;
}): Promise<string> {
  const salonId = args.salonId.trim().toLowerCase();
  const phone = args.phone.replace(/\D/g, "");
  if (!UUID_RE.test(salonId) || phone.length < 7 || phone.length > 15) {
    throw new Error("invalid_sequence_draft_identity");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify({ v: 1, salonId, phone })),
  );
  const hex = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `nq:sequence-intent:${hex}`;
}
