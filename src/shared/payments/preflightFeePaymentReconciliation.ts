import "server-only";

import { resolvePaymentProvider, type PaymentProvider } from "@/shared/integrations/payments";
import type { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  parseBookingPaymentOperationMaterial,
  type ClaimedBookingPaymentOperation,
} from "./bookingPaymentOperations";

type FeeKind = "noshow_charge" | "late_cancel_charge";
type FeePurpose = "approved_no_show_charge" | "approved_cancellation_fee";
type ReadyFee = {
  provider: PaymentProvider;
  materialFingerprint: string;
  materialSignature: string;
  salonId: string;
  operationKind: FeeKind;
};
export type FeeReconciliationPreflight = {
  claims: unknown[];
  ready: Map<string, ReadyFee>;
  unresolved: number;
  scanLimitReached: boolean;
};

const CANDIDATE_LIMIT_PER_KIND = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Read configuration before SQL consumes an attempt. Provider failures after
 * dispatch retain the normal attempt/unknown semantics; this never decrements
 * attempts or changes immutable operation material. */
export async function preflightFeePaymentReconciliation(
  db: ReturnType<typeof createServiceRoleClient>,
  scopes: Array<{ kind: FeeKind; purpose?: FeePurpose }>,
): Promise<FeeReconciliationPreflight> {
  const result: FeeReconciliationPreflight = {
    claims: [], ready: new Map(), unresolved: 0, scanLimitReached: false,
  };
  if (!scopes.length) return result;
  const now = new Date().toISOString();
  try {
    const queries = await Promise.all(scopes.map(({ kind }) => db.from("booking_payment_operations")
      .select("id,salon_id,operation_kind,provider,material_json,material_fingerprint,salons!inner(feature_flags)")
      .eq("operation_kind", kind)
      .eq(`salons.feature_flags->${kind === "noshow_charge"
        ? "approved_no_show_charge_dispatch" : "approved_cancellation_fee_dispatch"}`, true)
      .lt("attempt_count", 3)
      .or("delivery_mode.is.null,delivery_mode.neq.public_customer_present")
      .or(`and(status.in.(sending,reconciling),lease_expires_at.lte.${now}),and(status.in.(pending_provider,unknown),or(lease_expires_at.is.null,lease_expires_at.lte.${now}),or(next_reconcile_at.lte.${now},and(next_reconcile_at.is.null,updated_at.lte.${now})))`)
      .order("updated_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(CANDIDATE_LIMIT_PER_KIND)));
    // A full bounded scan is explicitly unresolved: unavailable configurations
    // must not silently hide ready salons later in the queue from operators.
    result.scanLimitReached = queries.some(({ data }) => data?.length === CANDIDATE_LIMIT_PER_KIND);
    if (result.scanLimitReached) result.unresolved += 1;
    result.unresolved += queries.filter(({ data, error }) => error || !Array.isArray(data)).length;
    const providers = new Map<string, PaymentProvider | null>();
    for (const row of queries.flatMap(({ data, error }) => !error && Array.isArray(data) ? data : [])) {
      const scope = scopes.find(({ kind }) => kind === row.operation_kind);
      const raw = row.material_json;
      const material = scope && raw && typeof raw === "object" && !Array.isArray(raw)
        ? parseBookingPaymentOperationMaterial(
          { ...raw, material_fingerprint: row.material_fingerprint }, scope.kind,
        ) : null;
      if (!material || !UUID_RE.test(row.id) || material.salonId !== row.salon_id ||
          material.provider !== row.provider || !material.providerMaterial.savedCardId ||
          !material.providerMaterial.customerId ||
          (scope?.purpose === "approved_cancellation_fee" && !material.cancellationReviewKind)) {
        result.unresolved += 1;
        continue;
      }
      const key = `${material.salonId}:${scope?.purpose ?? "payment"}:${material.provider}`;
      if (!providers.has(key)) {
        try {
          providers.set(key, await resolvePaymentProvider(material.salonId, {
            strict: true, purpose: scope?.purpose,
          }));
        } catch {
          providers.set(key, null);
        }
      }
      const provider = providers.get(key);
      if (!provider || provider.kind !== material.provider ||
          (provider.kind === "square" && !provider.assertPaymentIdentity)) {
        result.unresolved += 1;
        continue;
      }
      try {
        provider.assertPaymentIdentity?.({
          providerAccountId: material.providerMaterial.providerAccountId,
          providerLocationId: material.providerMaterial.providerLocationId,
          providerEnvironment: material.providerMaterial.providerEnvironment,
          providerCurrency: material.currency,
          providerAccountFingerprint: material.providerAccountFingerprint,
        });
      } catch {
        result.unresolved += 1;
        continue;
      }
      result.ready.set(row.id, {
        provider, materialFingerprint: material.materialFingerprint,
        materialSignature: JSON.stringify(material),
        salonId: material.salonId, operationKind: scope!.kind,
      });
    }
  } catch {
    result.unresolved += 1;
  }
  return result;
}

/** Call only after read-only preflight has finished, alongside other SQL claims. */
export async function claimReadyFeePaymentReconciliations(
  db: ReturnType<typeof createServiceRoleClient>,
  result: FeeReconciliationPreflight,
  limit = 25,
): Promise<void> {
  // Never interpret an empty set as "all operations".
  if (!result.ready.size || limit === 0) return;
  if (!Number.isInteger(limit) || limit < 0 || limit > 25) {
    result.unresolved += 1;
    return;
  }
  try {
    const claimed = await db.rpc("discover_due_ready_fee_payment_reconciliations" as never, {
      p_operation_ids: [...result.ready.keys()],
      p_operation_kinds: [...new Set([...result.ready.values()].map(({ operationKind }) => operationKind))],
      p_limit: limit,
    } as never);
    if (claimed.error || !Array.isArray(claimed.data)) {
      result.unresolved += 1;
      return;
    }
    result.claims = claimed.data;
  } catch {
    result.unresolved += 1;
  }
}

/** A claim must retain the exact preflight identity before the cached provider
 * can be used. An unexpected/stale response never falls back to provider lookup. */
export function preflightProviderForClaim(
  result: FeeReconciliationPreflight,
  claim: ClaimedBookingPaymentOperation,
): PaymentProvider | null {
  const ready = result.ready.get(claim.operationId);
  return ready && ready.salonId === claim.material.salonId &&
    ready.operationKind === claim.material.operationKind &&
    ready.materialFingerprint === claim.material.materialFingerprint &&
    ready.materialSignature === JSON.stringify(claim.material) &&
    ready.provider.kind === claim.material.provider ? ready.provider : null;
}
