import "server-only";
import { loadSquareCustomerIdentityMap } from "./customerIdentity";
import { looseServiceClient, type LooseDb } from "./looseDb";
import { getSquareConfig, listAllCustomers, type SquareConfig } from "./client";

const IDENTITY_PAGE_SIZE = 500;
const IDENTITY_PAGE_CAP = 100;

async function loadMultiNamespaceProfileIds(
  db: LooseDb,
  cfg: SquareConfig,
  profileIds: string[],
): Promise<Set<string>> {
  const namespaces = new Map<string, Set<string>>();
  const expectedNamespace = `${cfg.environment}\n${cfg.merchantId.trim()}`;

  for (let batchOffset = 0; batchOffset < profileIds.length; batchOffset += 100) {
    const chunk = profileIds.slice(batchOffset, batchOffset + 100);
    const expectedProfiles = new Set(chunk);
    for (let page = 0; page < IDENTITY_PAGE_CAP; page += 1) {
      const from = page * IDENTITY_PAGE_SIZE;
      const { data, error } = await db
        .from("square_customer_identities")
        .select("id, client_profile_id, provider_environment, provider_merchant_id")
        .in("client_profile_id", chunk)
        .order("id", { ascending: true })
        .range(from, from + IDENTITY_PAGE_SIZE - 1);
      if (error || !Array.isArray(data)) {
        throw new Error("square_email_consent_namespace_lookup_unavailable");
      }

      for (const rawRow of data) {
        if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) {
          throw new Error("square_email_consent_namespace_lookup_unavailable");
        }
        const row = rawRow as Record<string, unknown>;
        const id = typeof row.id === "string" ? row.id : "";
        const profileId = typeof row.client_profile_id === "string"
          ? row.client_profile_id.toLowerCase()
          : "";
        const environment = row.provider_environment;
        const merchantId = typeof row.provider_merchant_id === "string"
          ? row.provider_merchant_id
          : "";
        if (
          !id
          || !expectedProfiles.has(profileId)
          || (environment !== "sandbox" && environment !== "production")
          || !merchantId
          || merchantId !== merchantId.trim()
        ) {
          throw new Error("square_email_consent_namespace_lookup_unavailable");
        }
        const profileNamespaces = namespaces.get(profileId) ?? new Set<string>();
        profileNamespaces.add(`${environment}\n${merchantId}`);
        namespaces.set(profileId, profileNamespaces);
      }

      if (data.length < IDENTITY_PAGE_SIZE) break;
      if (page === IDENTITY_PAGE_CAP - 1) {
        throw new Error("square_email_consent_namespace_lookup_unavailable");
      }
    }
  }

  const multiNamespace = new Set<string>();
  for (const profileId of profileIds) {
    const profileNamespaces = namespaces.get(profileId);
    if (!profileNamespaces?.has(expectedNamespace)) {
      throw new Error("square_email_consent_namespace_lookup_unavailable");
    }
    if (profileNamespaces.size > 1) multiNamespace.add(profileId);
  }
  return multiNamespace;
}

/**
 * Sync EMAIL-only marketing consent from Square into client_profiles.
 *
 * A Square customer whose `preferences.email_unsubscribed` is not true (and who
 * has an email on file) is subscribed to the salon's email marketing — i.e. they
 * have consented to EMAIL. We stamp `client_profiles.marketing_email_consent_at`
 * for them (preserving the first-seen timestamp), and CLEAR it for anyone who
 * has since unsubscribed, so opt-outs propagate.
 *
 * IMPORTANT: this is EMAIL consent ONLY. It must never unlock SMS — the agents
 * gate SMS on `marketing_consent_at` (the full online opt-in). Matching is
 * scoped to the exact Square environment + merchant; an identifier collision
 * in another account can never modify this profile's consent.
 */
export async function syncSquareEmailConsent(salonId: string): Promise<{
  ok: boolean;
  squareCustomers: number;
  granted: number;
  revoked: number;
  error?: string;
}> {
  const db = looseServiceClient();

  let cfg: SquareConfig;
  try {
    cfg = await getSquareConfig(db, salonId);
  } catch (e) {
    return { ok: false, squareCustomers: 0, granted: 0, revoked: 0, error: String(e) };
  }

  let customers;
  try {
    customers = await listAllCustomers(cfg);
  } catch (e) {
    return { ok: false, squareCustomers: 0, granted: 0, revoked: 0, error: String(e) };
  }

  // Square customer_id → subscribed? (has email AND not unsubscribed)
  const subscribed = new Map<string, boolean>();
  for (const c of customers) {
    if (!c.id) continue;
    const hasEmail = !!(c.email_address ?? "").trim();
    const optedOut = c.preferences?.email_unsubscribed === true;
    subscribed.set(c.id, hasEmail && !optedOut);
  }

  const squareIds = [...subscribed.keys()];
  if (squareIds.length === 0) {
    return { ok: true, squareCustomers: 0, granted: 0, revoked: 0 };
  }

  let idToProfile: Map<string, string>;
  try {
    idToProfile = await loadSquareCustomerIdentityMap(db, cfg, squareIds);
  } catch (error) {
    return {
      ok: false,
      squareCustomers: customers.length,
      granted: 0,
      revoked: 0,
      error: String(error),
    };
  }

  // Multiple Square records can deduplicate to one canonical phone profile.
  // Any explicit opt-out wins for that profile.
  const profileSubscribed = new Map<string, boolean>();
  for (const [squareId, profileId] of idToProfile) {
    const isSubscribed = subscribed.get(squareId) === true;
    profileSubscribed.set(
      profileId,
      (profileSubscribed.get(profileId) ?? true) && isSubscribed,
    );
  }

  const grantProfileIds: string[] = [];
  const revokeProfileIds: string[] = [];
  const profileIds = [...profileSubscribed.keys()];
  let multiNamespaceProfileIds: Set<string>;
  try {
    multiNamespaceProfileIds = await loadMultiNamespaceProfileIds(db, cfg, profileIds);
  } catch {
    return {
      ok: false,
      squareCustomers: customers.length,
      granted: 0,
      revoked: 0,
      error: "square_email_consent_namespace_lookup_unavailable",
    };
  }
  for (let i = 0; i < profileIds.length; i += 300) {
    const chunk = profileIds.slice(i, i + 300);
    const { data, error } = await db
      .from("client_profiles")
      .select("id, marketing_email_consent_at")
      .in("id", chunk);
    if (error) {
      return {
        ok: false,
        squareCustomers: customers.length,
        granted: 0,
        revoked: 0,
        error: "square_email_consent_profile_lookup_unavailable",
      };
    }
    for (const r of ((data as
      | { id: string; marketing_email_consent_at: string | null }[]
      | null) ?? [])) {
      const isSubscribed = profileSubscribed.get(r.id) === true;
      if (
        isSubscribed
        && !r.marketing_email_consent_at
        && !multiNamespaceProfileIds.has(r.id)
      ) {
        grantProfileIds.push(r.id); // subscribe: stamp only if not already set
      } else if (!isSubscribed && r.marketing_email_consent_at) {
        revokeProfileIds.push(r.id); // opted out: clear so it propagates
      }
    }
  }

  const nowIso = new Date().toISOString();
  let granted = 0;
  let revoked = 0;

  for (let i = 0; i < grantProfileIds.length; i += 300) {
    const chunk = grantProfileIds.slice(i, i + 300);
    const { error } = await db
      .from("client_profiles")
      .update({ marketing_email_consent_at: nowIso } as never)
      .in("id", chunk)
      .is("marketing_email_consent_at", null);
    if (error) {
      return {
        ok: false,
        squareCustomers: customers.length,
        granted,
        revoked,
        error: "square_email_consent_grant_update_unavailable",
      };
    }
    granted += chunk.length;
  }
  for (let i = 0; i < revokeProfileIds.length; i += 300) {
    const chunk = revokeProfileIds.slice(i, i + 300);
    const { error } = await db
      .from("client_profiles")
      .update({ marketing_email_consent_at: null } as never)
      .in("id", chunk);
    if (error) {
      return {
        ok: false,
        squareCustomers: customers.length,
        granted,
        revoked,
        error: "square_email_consent_revoke_update_unavailable",
      };
    }
    revoked += chunk.length;
  }

  return { ok: true, squareCustomers: customers.length, granted, revoked };
}
