type RpcClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  const candidate = Array.isArray(value) && value.length === 1 ? value[0] : value;
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as JsonObject
    : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

export type SmsConsentDecision = {
  allowed: boolean;
  reason:
    | "clear"
    | "provider_stop"
    | "salon_suppression"
    | "salon_sms_disabled"
    | "consent_unavailable";
};

/**
 * Edge-function equivalent of the Next.js outbound chokepoint. It uses only
 * the service-role, PII-minimized DB contract and fails closed before Twilio.
 */
export async function requireSmsConsentClear(
  db: RpcClient,
  salonId: string,
  phone: string,
): Promise<SmsConsentDecision> {
  if (!UUID_RE.test(salonId)) return { allowed: false, reason: "consent_unavailable" };

  const hashedResult = await db.rpc("hash_sms_consent_phone", { p_phone: phone });
  const hashed = object(hashedResult.data);
  const phoneHash = typeof hashed?.phone_hash === "string" ? hashed.phone_hash : "";
  const hashKeyId = typeof hashed?.hash_key_id === "string" ? hashed.hash_key_id : "";
  if (
    hashedResult.error || hashed?.success !== true || hashed.code !== "hashed" ||
    hashed.contract_version !== 1 || !SHA256_RE.test(phoneHash) || !UUID_RE.test(hashKeyId)
  ) return { allowed: false, reason: "consent_unavailable" };

  const loadedResult = await db.rpc("load_sms_outbound_suppression", {
    p_salon_id: salonId,
    p_phone_hash: phoneHash,
    p_hash_key_id: hashKeyId,
  });
  const loaded = object(loadedResult.data);
  if (
    loadedResult.error || loaded?.success !== true || loaded.contract_version !== 1 ||
    loaded.affirmative_consent_not_evaluated !== true || typeof loaded.suppressed !== "boolean"
  ) return { allowed: false, reason: "consent_unavailable" };

  if (loaded.code === "clear" && loaded.suppressed === false && loaded.reason === "clear") {
    return { allowed: true, reason: "clear" };
  }
  if (loaded.code === "suppressed" && loaded.suppressed === true) {
    if (
      loaded.reason === "provider_stop" || loaded.reason === "salon_suppression" ||
      loaded.reason === "salon_sms_disabled"
    ) return { allowed: false, reason: loaded.reason };
  }
  return { allowed: false, reason: "consent_unavailable" };
}
