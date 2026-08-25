import "server-only";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { getSquareConfig } from "@/shared/integrations/square/client";
import { SquareProvider } from "./square";
import type { PaymentProvider, PaymentProviderKind } from "./types";

export type { PaymentProvider } from "./types";

/**
 * Resolve the customer-payment provider for a salon from
 * `salons.payment_provider`. Falls back to 'square' when the column is null but
 * square_integrations is connected (back-compat for salons already on Square).
 * Returns null when no provider is configured (caller treats as "off").
 */
export async function resolvePaymentProvider(
  salonId: string,
): Promise<PaymentProvider | null> {
  const db = looseServiceClient();

  const { data: salonRow } = await db
    .from("salons")
    .select(
      "payment_provider, currency_code, stripe_connect_account_id, stripe_connect_charges_enabled, stripe_connect_details_submitted",
    )
    .eq("id", salonId)
    .maybeSingle();
  const salon = (salonRow as Row | null) ?? null;
  let kind = (salon?.payment_provider as PaymentProviderKind | null) ?? null;

  if (!kind) {
    const { data: si } = await db
      .from("square_integrations")
      .select("enabled")
      .eq("salon_id", salonId)
      .maybeSingle();
    if ((si as Row | null)?.enabled) kind = "square";
  }

  if (kind === "square") {
    try {
      const cfg = await getSquareConfig(db, salonId);
      return new SquareProvider(cfg);
    } catch {
      return null; // not connected / missing token
    }
  }

  if (kind === "stripe") {
    const { getStripeClient } = await import("@/shared/lib/stripe");
    const stripe = getStripeClient();
    if (!stripe) return null; // no Stripe key configured
    const connectedAccountId = String(
      salon?.stripe_connect_account_id ?? "",
    ).trim();
    // Never route customer money through NailIQ's platform account. A salon
    // must have completed Stripe Connect onboarding and be enabled for charges;
    // otherwise payment protection is unavailable (fail closed).
    if (
      !connectedAccountId.startsWith("acct_") ||
      salon?.stripe_connect_charges_enabled !== true ||
      salon?.stripe_connect_details_submitted !== true
    ) {
      return null;
    }
    // Currency must match the salon's account — never hardcode.
    const currency = String(
      salon?.currency_code || "USD",
    ).trim().toLowerCase() || "usd";
    const { StripeProvider } = await import("./stripe");
    return new StripeProvider(stripe, connectedAccountId, currency);
  }

  return null;
}
