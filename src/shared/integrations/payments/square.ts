import "server-only";
import { createHash } from "node:crypto";
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

  private assertProviderIdentity(input: {
    providerAccountId?: string;
    providerLocationId?: string | null;
    providerEnvironment?: "sandbox" | "production" | null;
    providerCurrency?: string;
    providerAccountFingerprint?: string;
  }) {
    if (input.providerAccountId && input.providerAccountId !== this.cfg.merchantId) {
      throw new Error("square_provider_account_mismatch");
    }
    const fingerprint = createHash("sha256").update(
      `square:${this.cfg.merchantId}:${this.cfg.locationId}:${this.cfg.environment}`,
      "utf8",
    ).digest("hex");
    const durableIdentityIncomplete = input.providerAccountFingerprint !== undefined && (
      !input.providerAccountId || !input.providerLocationId ||
      !input.providerEnvironment || !input.providerCurrency
    );
    if (
      durableIdentityIncomplete ||
      (input.providerLocationId && input.providerLocationId !== this.cfg.locationId) ||
      (input.providerEnvironment && input.providerEnvironment !== this.cfg.environment) ||
      (input.providerCurrency && input.providerCurrency.toUpperCase() !== this.cfg.currency.toUpperCase()) ||
      (input.providerAccountFingerprint && input.providerAccountFingerprint !== fingerprint)
    ) {
      throw new Error("square_provider_identity_mismatch");
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
    cardReferenceId: string;
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
      referenceId: input.cardReferenceId,
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
    providerLocationId?: string | null;
    providerEnvironment?: "sandbox" | "production" | null;
    providerCurrency?: string;
    providerAccountFingerprint?: string;
  }) {
    this.assertProviderIdentity(input);
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
    providerLocationId?: string | null;
    providerEnvironment?: "sandbox" | "production" | null;
    providerCurrency?: string;
    providerAccountFingerprint?: string;
  }) {
    this.assertProviderIdentity(input);
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
