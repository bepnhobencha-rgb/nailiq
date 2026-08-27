import "server-only";
import type Stripe from "stripe";
import type { PaymentProvider } from "./types";
import { toProviderMinorAmount } from "@/shared/payments/providerMinorUnits";

/**
 * Stripe implementation of PaymentProvider — off-session card-on-file.
 *
 * Save = attach a PaymentMethod (from the client's Payment Element / Apple-Google
 * Pay SetupIntent) to a Customer, NO charge. Charge = off-session PaymentIntent.
 * This is what makes the "one-tap Face ID" capture possible (wallets save as a
 * reusable PaymentMethod, unlike Square).
 *
 * NOTE: this uses the PLATFORM Stripe account. Routing money to each salon's
 * connected account (Stripe Connect `on_behalf_of` / `transfer_data`) is Đợt 2;
 * until then the no-show flow stays test/sandbox only.
 */
export class StripeProvider implements PaymentProvider {
  readonly kind = "stripe" as const;
  constructor(
    private readonly stripe: Stripe,
    /** Salon account currency (lowercase ISO, e.g. 'cad'). Stripe charges in the
     *  account's currency — never hardcode. */
    private readonly currency: string = "usd",
  ) {}

  async saveCardOnFile(input: {
    customer: {
      name?: string | null;
      phone?: string | null;
      email?: string | null;
      referenceId: string;
    };
    /** A Stripe PaymentMethod id (pm_…) the client created/confirmed. */
    sourceToken: string;
    /** Ignored by Stripe — card verification happens via the SetupIntent the
     *  client already confirmed. Present only to satisfy the shared interface. */
    verificationToken?: string;
    idempotencyKey: string;
    cardReferenceId: string;
  }) {
    // Reuse an existing customer by exact email (immediate, no search lag); else
    // create one. Dedupe by email keeps a returning client's cards together.
    let customerId: string | null = null;
    const email = input.customer.email?.trim();
    if (email) {
      const existing = await this.stripe.customers.list({ email, limit: 1 });
      customerId = existing.data[0]?.id ?? null;
    }
    if (!customerId) {
      const created = await this.stripe.customers.create({
        name: input.customer.name ?? undefined,
        phone: input.customer.phone ?? undefined,
        email: email || undefined,
        metadata: {
          referenceId: input.customer.referenceId,
          cardReferenceId: input.cardReferenceId,
        },
      }, { idempotencyKey: `${input.idempotencyKey}:customer` });
      customerId = created.id;
    }

    const pm = await this.stripe.paymentMethods.attach(input.sourceToken, {
      customer: customerId,
    }, { idempotencyKey: `${input.idempotencyKey}:attach` });
    // Make it the default for off-session invoices/charges.
    await this.stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: pm.id },
    }, { idempotencyKey: `${input.idempotencyKey}:default` });

    return {
      customerId,
      cardId: pm.id,
      last4: pm.card?.last4 ?? "",
      brand: pm.card?.brand ?? "",
    };
  }

  async chargeSavedCard(input: {
    customerId: string;
    cardId: string;
    amountCents: number;
    idempotencyKey: string;
    note?: string;
    referenceId?: string;
    providerAccountId?: string;
  }) {
    const pi = await this.stripe.paymentIntents.create(
      {
        amount: toProviderMinorAmount(input.amountCents, this.currency),
        currency: this.currency,
        customer: input.customerId,
        payment_method: input.cardId,
        off_session: true,
        confirm: true,
        description: input.note,
        metadata: input.referenceId ? { referenceId: input.referenceId } : undefined,
      },
      {
        idempotencyKey: input.idempotencyKey,
        ...(input.providerAccountId
          ? { stripeAccount: input.providerAccountId }
          : {}),
      },
    );
    return { paymentId: pi.id, status: pi.status };
  }

  async refund(input: {
    paymentId: string;
    amountCents: number;
    reason: string;
    idempotencyKey: string;
    providerAccountId?: string;
  }) {
    const r = await this.stripe.refunds.create(
      {
        payment_intent: input.paymentId,
        amount: toProviderMinorAmount(input.amountCents, this.currency),
      },
      {
        idempotencyKey: input.idempotencyKey,
        ...(input.providerAccountId
          ? { stripeAccount: input.providerAccountId }
          : {}),
      },
    );
    return { refundId: r.id, status: r.status ?? "" };
  }

  async removeSavedCard(input: { cardId: string; customerId: string }) {
    // Detach is retried only under the DB-owned operation id. If the first
    // response was lost, retrieve the exact PaymentMethod and accept only the
    // authoritative already-detached state (customer=null).
    try {
      const current = await this.stripe.paymentMethods.retrieve(input.cardId);
      if (current.customer == null) return { providerReference: current.id };
      const removed = await this.stripe.paymentMethods.detach(input.cardId);
      return { providerReference: removed.id };
    } catch (cause) {
      try {
        const current = await this.stripe.paymentMethods.retrieve(input.cardId);
        if (current.customer == null) return { providerReference: current.id };
      } catch {
        // The provider state is still ambiguous; do not report success.
      }
      throw cause;
    }
  }

  async findSavedCardByPhone(phone: string) {
    const digits = (phone || "").replace(/\D/g, "");
    if (digits.length < 8) return null;
    const last10 = digits.slice(-10);
    // Search Customer by phone (try E.164 variants — Stripe stores what we sent).
    const queries = [`phone:'+${digits}'`, `phone:'${digits}'`, `phone:'+1${last10}'`];
    let customerId: string | null = null;
    for (const query of queries) {
      try {
        const res = await this.stripe.customers.search({ query, limit: 1 });
        if (res.data[0]?.id) { customerId = res.data[0].id; break; }
      } catch {
        /* search index not ready / bad query — try next */
      }
    }
    if (!customerId) return null;
    const pms = await this.stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
    const pm = pms.data[0];
    if (!pm) return null;
    return { customerId, cardId: pm.id, last4: pm.card?.last4 ?? "", brand: pm.card?.brand ?? "" };
  }
}
