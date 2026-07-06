import "server-only";
import { looseServiceClient } from "./looseDb";
import { getSquareConfig, listAllCustomers, type SquareConfig } from "./client";

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
 * gate SMS on `marketing_consent_at` (the full online opt-in). Matched by
 * `square_customer_id`, which the booking/customer sync sets on the profile.
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

  // Match to local profiles by square_customer_id (batched IN lookups).
  const grantProfileIds: string[] = [];
  const revokeProfileIds: string[] = [];
  for (let i = 0; i < squareIds.length; i += 300) {
    const chunk = squareIds.slice(i, i + 300);
    const { data } = await db
      .from("client_profiles")
      .select("id, square_customer_id, marketing_email_consent_at")
      .in("square_customer_id", chunk);
    for (const r of ((data as
      | { id: string; square_customer_id: string | null; marketing_email_consent_at: string | null }[]
      | null) ?? [])) {
      const sid = r.square_customer_id;
      if (!sid) continue;
      const isSubscribed = subscribed.get(sid) === true;
      if (isSubscribed && !r.marketing_email_consent_at) {
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
    if (!error) granted += chunk.length;
  }
  for (let i = 0; i < revokeProfileIds.length; i += 300) {
    const chunk = revokeProfileIds.slice(i, i + 300);
    const { error } = await db
      .from("client_profiles")
      .update({ marketing_email_consent_at: null } as never)
      .in("id", chunk);
    if (!error) revoked += chunk.length;
  }

  return { ok: true, squareCustomers: customers.length, granted, revoked };
}
