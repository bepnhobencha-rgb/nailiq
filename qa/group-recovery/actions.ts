"use server";
import { cookies } from "next/headers";
const token = "a".repeat(64);
const expiresAt = "2030-09-25T20:00:00Z";
export async function loadGroupSlotRecovery() {
  const jar = await cookies();
  if (jar.get("qa-fault")?.value === "disabled") return { ok: false as const, code: "feature_disabled" };
  if (jar.get("qa-fault")?.value === "read-error") return { ok: false as const, code: "server_error" };
  const card = jar.get("qa-fault")?.value === "card";
  const state = jar.get("qa-accepted") ? "accepted" as const : jar.get("qa-started") ? "pending" as const : card ? "unavailable" as const : "available" as const;
  return { ok: true as const, state, eligible: !card && state !== "accepted", reason: card ? "card_required" : null, expiresAt: state === "pending" ? expiresAt : null, timezone: "America/Vancouver" };
}
export async function startGroupReplacement(input: { cancelToken: string; requestId: string }) {
  const jar = await cookies();
  const count = Number(jar.get("qa-start-count")?.value ?? 0);
  jar.set("qa-start-count", String(count + 1));
  jar.set("qa-start-request", input.requestId);
  jar.set("qa-started", "1");
  return { ok: true as const, token, expiresAt, idempotent: count > 0 };
}
export async function loadGroupReplacementPreview(token: string) {
  if (!token) return { ok: false as const, code: "invalid_input" };
  const jar = await cookies();
  if (jar.get("qa-fault")?.value === "expired") return { ok: false as const, code: "expired" };
  return { ok: true as const, state: jar.get("qa-accepted") ? "accepted" as const : "available" as const, salonName: "Synthetic Recovery QA", serviceName: "QA service", startTimeUtc: "2030-09-26T19:00:00Z", endTimeUtc: "2030-09-26T20:00:00Z", timezone: "America/Vancouver", currency: "CAD", priceCents: 12500, expiresAt, requiresCard: jar.get("qa-fault")?.value === "card" };
}
export async function acceptGroupReplacement(input: { token: string; requestId: string; name: string; phone: string; consentAccepted: boolean }) {
  const jar = await cookies();
  const count = Number(jar.get("qa-accept-count")?.value ?? 0);
  jar.set("qa-accept-count", String(count + 1));
  const previous = jar.get("qa-request")?.value;
  if (previous && previous !== input.requestId) return { ok: false as const, code: "request_conflict" };
  if (jar.get("qa-fault")?.value === "same-contact" && count === 0) return { ok: false as const, code: "different_guest_required" };
  jar.set("qa-request", input.requestId);
  if (jar.get("qa-fault")?.value === "unknown" && count === 0) return { ok: false as const, code: "server_error" };
  jar.set("qa-accepted", "1");
  return { ok: true as const, state: "accepted" as const, idempotent: count > 0 };
}

export async function revokeGroupReplacement(input: { cancelToken: string; requestId: string }) {
  const jar = await cookies();
  jar.set("qa-revoke-request", input.requestId);
  jar.delete("qa-started");
  return { ok: true as const };
}
