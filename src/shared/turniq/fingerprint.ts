function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) =>
          left === right ? 0 : left < right ? -1 : 1,
        )
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("turniq_non_finite_fingerprint_value");
  }
  return value;
}

/** Deterministic JSON used only for TurnIQ decision identity. */
export function canonicalTurnIqJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

/** Browser/Node-compatible SHA-256 with no server or provider dependency. */
export async function sha256TurnIqHex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
