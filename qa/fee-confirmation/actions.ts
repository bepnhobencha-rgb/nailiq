"use server";
import { cookies } from "next/headers";
async function finish(slug: string, collecting: boolean) {
  const jar = await cookies();
  const fault = jar.get("qa-fault")?.value;
  if (collecting && fault === "stale-unknown") return { ok: false, error: "provider_unknown" };
  if (collecting && fault === "consent-cap") return { ok: false, error: "group_fee_amount_exceeds_cap" };
  const status = fault === "decline" ? "failed" : fault === "unknown" ? "unknown" : "succeeded";
  jar.set(`qa-status-${slug}`, collecting ? status : "dispatch_blocked");
  if (collecting && fault) return { ok: false, error: fault === "decline" ? "card_declined" : "provider_unknown" };
  return { ok: true };
}
export async function dispatchApprovedNoShowFee(slug: string) { return finish(slug, true); }
export async function dispatchApprovedCancellationFee(slug: string) { return finish(slug, true); }
export async function decideNoShowFeeReview(slug: string) { return finish(slug, false); }
export async function requestNoShowFeeReview(slug: string) { return finish(slug, false); }
export async function decideLateCancellationFeeReview(slug: string) { return finish(slug, false); }
export async function decideGroupCancellationFeeReview(slug: string) { return finish(slug, false); }
