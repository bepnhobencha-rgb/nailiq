import "server-only";
import {
  type SquareConfig,
  ensureSquareCustomer,
  saveCardOnFile as sqSaveCard,
  chargeSavedCard as sqCharge,
  refundPayment as sqRefund,
  disableCard as sqDisableCard,
  findSquareCustomerByPhone,
  listCards as sqListCards,
} from "@/shared/integrations/square/client";
import type { PaymentProvider } from "./types";
import { toProviderMinorAmount } from "@/shared/payments/providerMinorUnits";

/** Square implementation of PaymentProvider — thin wrapper over the existing
 *  Square REST helpers (behaviour identical to the previous direct calls). */
export class SquareProvider implements PaymentProvider {
  readonly kind = "square" as const;
  constructor(private readonly cfg: SquareConfig) {}

  private assertProviderAccount(providerAccountId?: string) {
    if (providerAccountId && providerAccountId !== this.cfg.merchantId) {
      throw new Error("square_provider_account_mismatch");
    }
  }

  async saveCardOnFile(input: {
    customer: {
      name?: string | null;
      phone?: string | null;
      email?: string | null;
      referenceId: string;
    };
    sourceToken: string;
    verificationToken?: string;
    idempotencyKey: string;
  }) {
    const customerId = await ensureSquareCustomer(this.cfg, {
      name: input.customer.name ?? null,
      phone: input.customer.phone ?? null,
      email: input.customer.email ?? null,
      referenceId: input.customer.referenceId,
      idempotencyKey: `${input.idempotencyKey}:customer`,
    });
    const card = await sqSaveCard(this.cfg, {
      customerId,
      sourceId: input.sourceToken,
      idempotencyKey: `${input.idempotencyKey}:card`,
      verificationToken: input.verificationToken,
    });
    return {
      customerId,
      cardId: card.cardId,
      last4: card.last4,
      brand: card.brand,
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
    this.assertProviderAccount(input.providerAccountId);
    const r = await sqCharge(this.cfg, {
      cardId: input.cardId,
      customerId: input.customerId,
      amountCents: toProviderMinorAmount(input.amountCents, this.cfg.currency),
      idempotencyKey: input.idempotencyKey,
      note: input.note,
      referenceId: input.referenceId,
    });
    return { paymentId: r.paymentId, status: r.status };
  }

  async refund(input: {
    paymentId: string;
    amountCents: number;
    reason: string;
    idempotencyKey: string;
    providerAccountId?: string;
  }) {
    this.assertProviderAccount(input.providerAccountId);
    const r = await sqRefund(this.cfg, {
      paymentId: input.paymentId,
      amountCents: toProviderMinorAmount(input.amountCents, this.cfg.currency),
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    return { refundId: r.id, status: r.status };
  }

  async removeSavedCard(input: { cardId: string; customerId: string }) {
    await sqDisableCard(this.cfg, input.cardId);
    return { providerReference: input.cardId };
  }

  async findSavedCardByPhone(phone: string) {
    const customerId = await findSquareCustomerByPhone(this.cfg, phone);
    if (!customerId) return null;
    const cards = await sqListCards(this.cfg, customerId);
    const card = cards[0];
    if (!card || !card.cardId) return null;
    return { customerId, cardId: card.cardId, last4: card.last4, brand: card.brand };
  }
}
