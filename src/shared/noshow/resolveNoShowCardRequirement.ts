"use server";

import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { resolvePaymentProvider } from "@/shared/integrations/payments";
import { getSquareConfig } from "@/shared/integrations/square/client";

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const str = (v: unknown): string => (v == null ? "" : String(v));

export type NoShowCardRequirement =
  | { required: false }
  | {
      required: true;
      feeCents: number;
      provider: "square";
      applicationId: string;
      locationId: string;
      environment: "production" | "sandbox";
    };

/**
 * Decide — BEFORE the booking row exists — whether this customer must leave a
 * card to confirm (new customer, or one with a prior no-show), for a salon with
 * no-show protection + a connected provider + a non-zero fee. Powers the
 * card-gate INSIDE the confirm step (Option A): no booking is created and no
 * SMS/email is sent until the card is captured.
 *
 * Deterministic + fast (no AI call): new customer OR previous no-show. The full
 * AI risk score is still computed post-booking for the dashboard (unchanged).
 *
 * Square only for now (Hi-Lite's provider). Stripe wallets are Đợt 2 (dormant
 * until Connect) and keep the post-booking path.
 */
export async function resolveNoShowCardRequirement(args: {
  salonId: string;
  serviceId: string;
  clientPhone: string;
}): Promise<NoShowCardRequirement> {
  try {
    const db = looseServiceClient();

    // Policy on the salon.
    const { data: salon } = await db
      .from("salons")
      .select("noshow_protection_enabled, noshow_fee_percent")
      .eq("id", args.salonId)
      .maybeSingle();
    const s = (salon ?? {}) as Row;
    if (!s.noshow_protection_enabled) return { required: false };
    const percent = num(s.noshow_fee_percent) || 20;

    // Provider must be connected; Square-only gate for the pre-booking flow.
    const provider = await resolvePaymentProvider(args.salonId);
    if (!provider || provider.kind !== "square") return { required: false };

    // Fee from the service price.
    const { data: svc } = await db
      .from("services")
      .select("price_cents")
      .eq("id", args.serviceId)
      .maybeSingle();
    const priceCents = num((svc as Row | null)?.price_cents);
    const feeCents = Math.round((priceCents * percent) / 100);
    if (feeCents <= 0) return { required: false };

    // Gate: new customer (no prior non-cancelled booking at this salon) OR a
    // customer with a prior no-show.
    const phone = args.clientPhone.replace(/\D/g, "");
    let isNew = true;
    let hadNoShow = false;
    if (phone.length >= 8) {
      const { data: prior } = await db
        .from("bookings")
        .select("status")
        .eq("salon_id", args.salonId)
        .eq("client_phone", phone)
        .not("status", "eq", "cancelled")
        .limit(50);
      const rows = (prior ?? []) as Row[];
      isNew = rows.length === 0;
      hadNoShow = rows.some((r) => str(r.status) === "no_show");
    }
    if (!isNew && !hadNoShow) return { required: false };

    // Public Web Payments SDK params.
    const cfg = await getSquareConfig(db, args.salonId);
    if (!cfg.applicationId) return { required: false };

    return {
      required: true,
      feeCents,
      provider: "square",
      applicationId: cfg.applicationId,
      locationId: cfg.locationId,
      environment: cfg.environment,
    };
  } catch (e) {
    console.error("[resolveNoShowCardRequirement]", e);
    return { required: false }; // fail-open: never block a booking on this check
  }
}
