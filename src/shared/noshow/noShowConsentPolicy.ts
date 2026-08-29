import "server-only";

import { createHash } from "node:crypto";
import {
  evaluatePolicyReadiness,
  resolvePolicy,
  type StoredPolicy,
} from "@/shared/lib/cancellationPolicy";

export type NoShowPolicyScope = "booking_member" | "whole_party";

export type NoShowConsentPolicy = {
  ready: boolean;
  reasons: ReturnType<typeof evaluatePolicyReadiness>["reasons"];
  version: string | null;
  feeCents: number;
  currency: string;
  scope: NoShowPolicyScope;
  policyEn: string;
  policyVi: string;
};

export function buildNoShowConsentPolicy(input: {
  storedPolicy: StoredPolicy;
  salonName: string;
  feeCents: number;
  currency: string;
  scope: NoShowPolicyScope;
}): NoShowConsentPolicy {
  const readiness = evaluatePolicyReadiness(input.storedPolicy);
  const feeCents = Math.max(0, Math.round(input.feeCents));
  const currency = input.currency.trim().toUpperCase();
  const policyEn = resolvePolicy(input.storedPolicy, "en", input.salonName);
  const policyVi = resolvePolicy(input.storedPolicy, "vi", input.salonName);
  const ready = readiness.ready && feeCents > 0 && /^[A-Z]{3}$/.test(currency);
  const version = ready
    ? `nsp_${createHash("sha256")
        .update(JSON.stringify({ policyEn, policyVi, feeCents, currency, scope: input.scope }))
        .digest("hex")}`
    : null;
  return {
    ready,
    reasons: readiness.reasons,
    version,
    feeCents,
    currency,
    scope: input.scope,
    policyEn,
    policyVi,
  };
}

export function consentMetaMatchesPolicy(
  meta: unknown,
  policy: Pick<NoShowConsentPolicy, "ready" | "version" | "feeCents" | "currency" | "scope">,
): boolean {
  if (!policy.ready || !policy.version || !meta || typeof meta !== "object" || Array.isArray(meta)) {
    return false;
  }
  const row = meta as Record<string, unknown>;
  return row.policyVersion === policy.version &&
    row.feeCents === policy.feeCents &&
    row.currency === policy.currency &&
    row.scope === policy.scope;
}
