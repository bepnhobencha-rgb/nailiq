import "server-only";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { getSquareConfig } from "@/shared/integrations/square/client";
import { SquareProvider } from "./square";
import type { PaymentProvider, PaymentProviderKind } from "./types";
import {
  allowsApprovedNoShowChargeDispatch,
  v1AllowsCustomerPaymentGateway,
  v1AllowsNoShowCardOnFile,
} from "@/shared/release/v1IntegrationScope";

export type { PaymentProvider } from "./types";

/**
 * Resolve the customer-payment provider for a salon from
 * `salons.payment_provider`. Falls back to 'square' when the column is null but
 * square_integrations is connected (back-compat for salons already on Square).
 * Returns null when no provider is configured (caller treats as "off").
 */
export async function resolvePaymentProvider(
  salonId: string,
  options?: {
    strict?: boolean;
    purpose?: "payment" | "card_on_file" | "approved_no_show_charge";
  },
): Promise<PaymentProvider | null> {
  const allowed = options?.purpose === "card_on_file"
    ? v1AllowsNoShowCardOnFile()
    : options?.purpose === "approved_no_show_charge"
      ? allowsApprovedNoShowChargeDispatch()
      : v1AllowsCustomerPaymentGateway();
  if (!allowed) {
    if (options?.strict) throw new Error("v1_customer_payment_gateway_disabled");
    return null;
  }
  const db = looseServiceClient();

  const { data: salonRow, error: salonError } = await db
    .from("salons")
    .select("payment_provider, feature_flags")
    .eq("id", salonId)
    .maybeSingle();
  if (options?.strict && (salonError || !salonRow)) throw new Error("payment_provider_config_unavailable");
  if (options?.purpose === "approved_no_show_charge") {
    const flags = (salonRow as Row | null)?.feature_flags;
    if (!flags || typeof flags !== "object" || Array.isArray(flags) ||
        (flags as Record<string, unknown>).approved_no_show_charge_dispatch !== true) {
      if (options?.strict) throw new Error("salon_not_allowlisted");
      return null;
    }
  }
  let kind =
    ((salonRow as Row | null)?.payment_provider as PaymentProviderKind | null) ??
    null;

  if (!kind) {
    const { data: si, error: squareError } = await db
      .from("square_integrations")
      .select("enabled")
      .eq("salon_id", salonId)
      .maybeSingle();
    if (options?.strict && squareError) throw new Error("payment_provider_config_unavailable");
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
    // Currency must match the salon's account — never hardcode (Stripe charges
    // in the connected account's currency).
    const { data: salonRow, error: currencyError } = await db
      .from("salons")
      .select("currency_code")
      .eq("id", salonId)
      .maybeSingle();
    if (options?.strict && (currencyError || !salonRow)) throw new Error("payment_provider_currency_unavailable");
    const currency = String(
      (salonRow as Row | null)?.currency_code || "USD",
    ).trim().toLowerCase() || "usd";
    const { StripeProvider } = await import("./stripe");
    return new StripeProvider(stripe, currency);
  }

  return null;
}
