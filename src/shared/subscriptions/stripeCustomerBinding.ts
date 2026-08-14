import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Persist the first Stripe customer with compare-and-set semantics.
 *
 * Two workers may receive the same provider response after a lease handoff.
 * Only NULL may be changed. A zero-row UPDATE is not success: reread and accept
 * only the exact same binding, otherwise fail closed.
 */
export async function persistStripeCustomerBinding(input: {
  salonId: string;
  stripeCustomerId: string;
}): Promise<void> {
  const customerId = input.stripeCustomerId.trim();
  if (!customerId) throw new Error("stripe_customer_binding_invalid");

  const db = createServiceRoleClient();
  const { data: written, error: writeError } = await db
    .from("salons")
    .update({ stripe_customer_id: customerId })
    .eq("id", input.salonId)
    .is("stripe_customer_id", null)
    .select("stripe_customer_id")
    .maybeSingle();

  if (writeError) throw new Error("stripe_customer_binding_write_failed");
  const writtenId = (written as { stripe_customer_id?: string | null } | null)
    ?.stripe_customer_id;
  if (writtenId === customerId) return;

  const { data: current, error: readError } = await db
    .from("salons")
    .select("stripe_customer_id")
    .eq("id", input.salonId)
    .maybeSingle();
  if (readError) throw new Error("stripe_customer_binding_read_failed");
  const currentId = (current as { stripe_customer_id?: string | null } | null)
    ?.stripe_customer_id;
  if (currentId === customerId) return;

  throw new Error("stripe_customer_binding_conflict");
}
