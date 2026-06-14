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
    .select("payment_provider")
    .eq("id", salonId)
    .maybeSingle();
  let kind =
    ((salonRow as Row | null)?.payment_provider as PaymentProviderKind | null) ??
    null;

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

  // kind === "stripe" → Đợt 2: StripeProvider once Connect keys are configured.
  return null;
}
