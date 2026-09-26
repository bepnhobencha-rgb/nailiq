import { formatInSalonTz } from "@/shared/lib/salonTime";
import type { GroupRecoveryLanguage } from "@/shared/i18n/booking/groupRecovery";

/** Store an idempotency UUID only, never the bearer token or guest contact details. */
export async function groupRecoveryRequestId(token: string, action: "start" | "accept" | "revoke", clear = false): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const key = `nailiq-group-recovery:${action}:${hash}`;
  if (clear) sessionStorage.removeItem(key);
  const existing = sessionStorage.getItem(key);
  if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) return existing;
  const id = crypto.randomUUID();
  sessionStorage.setItem(key, id);
  return id;
}

export function groupRecoveryTime(iso: string, timezone: string, language: GroupRecoveryLanguage): string {
  return formatInSalonTz(iso, timezone, "datetime", language === "vi" ? "vi-VN" : "en-US");
}

export function groupRecoveryPrice(cents: number, currency: string, language: GroupRecoveryLanguage): string {
  return new Intl.NumberFormat(language === "vi" ? "vi-CA" : "en-CA", { style: "currency", currency }).format(cents / 100);
}
