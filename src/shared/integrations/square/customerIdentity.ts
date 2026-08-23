import "server-only";
import type { SquareConfig } from "./client";
import type { LooseDb } from "./looseDb";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOLVED_CODES = new Set([
  "created_profile",
  "linked_profile",
  "linked_salon",
  "replayed",
]);

const str = (value: unknown): string => value == null ? "" : String(value);
const record = (value: unknown): Record<string, unknown> | null => {
  const unwrapped = Array.isArray(value) ? value[0] : value;
  return unwrapped && typeof unwrapped === "object"
    ? unwrapped as Record<string, unknown>
    : null;
};

export type SquareCustomerIdentity = {
  clientProfileId: string;
  name: string | null;
  phone: string | null;
  createdProfile: boolean;
};

/**
 * Resolve one provider customer inside the exact Square account currently
 * configured for the salon. Omitting customer material performs a lookup-only
 * replay; supplying it permits the database to create/link the canonical phone
 * profile atomically. Consent fields are deliberately not part of this API.
 */
export async function resolveSquareCustomerIdentity(
  db: LooseDb,
  cfg: SquareConfig,
  input: {
    customerId: string;
    phone?: string | null;
    name?: string | null;
    email?: string | null;
  },
): Promise<SquareCustomerIdentity | null> {
  const { data, error } = await db.rpc("resolve_square_customer_identity", {
    p_salon_id: cfg.salonId,
    p_provider_environment: cfg.environment,
    p_provider_merchant_id: cfg.merchantId,
    p_provider_location_id: cfg.locationId,
    p_square_customer_id: input.customerId,
    p_phone: input.phone ?? null,
    p_name: input.name ?? null,
    p_email: input.email ?? null,
  });
  if (error) throw new Error("square_sync_customer_identity_unavailable");

  const row = record(data);
  const code = str(row?.code);
  if (code === "not_found") return null;

  const clientProfileId = str(row?.client_profile_id).toLowerCase();
  if (
    !RESOLVED_CODES.has(code)
    || !UUID_RE.test(clientProfileId)
    || typeof row?.created_profile !== "boolean"
    || (row.name !== null && row.name !== undefined && typeof row.name !== "string")
    || (row.phone !== null && row.phone !== undefined && typeof row.phone !== "string")
  ) {
    throw new Error("square_sync_customer_identity_response_invalid");
  }

  return {
    clientProfileId,
    name: typeof row.name === "string" ? row.name : null,
    phone: typeof row.phone === "string" ? row.phone : null,
    createdProfile: row.created_profile,
  };
}

/** Account-scoped batch map for Square-derived spend/visit/consent readers. */
export async function loadSquareCustomerIdentityMap(
  db: LooseDb,
  cfg: SquareConfig,
  customerIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const uniqueIds = [...new Set(customerIds.map((id) => id.trim()).filter(Boolean))];
  for (let offset = 0; offset < uniqueIds.length; offset += 300) {
    const chunk = uniqueIds.slice(offset, offset + 300);
    const { data, error } = await db
      .from("square_customer_identities")
      .select("square_customer_id, client_profile_id")
      .eq("provider_environment", cfg.environment)
      .eq("provider_merchant_id", cfg.merchantId.trim())
      .in("square_customer_id", chunk);
    if (error) throw new Error("square_customer_identity_map_unavailable");

    for (const row of data ?? []) {
      const customerId = str(row.square_customer_id);
      const profileId = str(row.client_profile_id).toLowerCase();
      if (!customerId || !UUID_RE.test(profileId) || result.has(customerId)) {
        throw new Error("square_customer_identity_map_invalid");
      }
      result.set(customerId, profileId);
    }
  }
  return result;
}
