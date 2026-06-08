"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { getStripeClient, getStripeReturnOrigin } from "@/shared/lib/stripe";

/**
 * Stripe Connect (Express) onboarding — Phase 1.
 *
 * Deposits (Phase 2) are charged on each salon's OWN connected account, so the
 * money goes to the salon, not the platform. Here we get-or-create the salon's
 * Express account and return a Stripe-hosted onboarding link. No money moves.
 *
 * Prerequisite: Connect must be enabled on the platform Stripe account
 * (Dashboard → Connect). Until then `accounts.create` throws → surfaced as
 * `connect_not_enabled`.
 */

type ConnectStatus = {
  accountId: string | null;
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
};

function returnUrls(slug: string) {
  const origin = getStripeReturnOrigin();
  const base = `${origin}/dashboard/${slug}/no-show-protection`;
  return {
    refresh_url: `${base}?stripe_connect=refresh`,
    return_url: `${base}?stripe_connect=return`,
  };
}

export async function startStripeConnectOnboarding(
  slug: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (ctx.role !== "owner") return { ok: false, error: "forbidden" };

  const stripe = getStripeClient();
  if (!stripe) return { ok: false, error: "stripe_not_configured" };

  try {
    // Reuse an existing account; else create a fresh Express account.
    const { data: salonRow } = await ctx.supabase
      .from("salons")
      .select("stripe_connect_account_id, email, name" as never)
      .eq("id", ctx.salon.id)
      .maybeSingle();
    const row = (salonRow ?? {}) as {
      stripe_connect_account_id?: string | null;
      email?: string | null;
      name?: string | null;
    };

    let accountId = row.stripe_connect_account_id ?? null;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: row.email ?? undefined,
        metadata: { salon_id: ctx.salon.id, salon_slug: slug },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_profile: { name: row.name ?? undefined },
      });
      accountId = account.id;
      const { error: upErr } = await ctx.supabase
        .from("salons")
        .update({ stripe_connect_account_id: accountId } as never)
        .eq("id", ctx.salon.id);
      if (upErr) {
        console.error("[startStripeConnectOnboarding] save account", upErr);
        return { ok: false, error: "server_error" };
      }
    }

    const { refresh_url, return_url } = returnUrls(slug);
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url,
      return_url,
      type: "account_onboarding",
    });
    return { ok: true, url: link.url };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Connect not turned on for the platform account yet.
    if (/connect/i.test(msg) && /not.*enabl|sign.*up.*connect|platform/i.test(msg)) {
      return { ok: false, error: "connect_not_enabled" };
    }
    console.error("[startStripeConnectOnboarding]", e);
    return { ok: false, error: "server_error" };
  }
}

export async function refreshStripeConnectStatus(
  slug: string,
): Promise<{ ok: true; status: ConnectStatus } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (ctx.role !== "owner") return { ok: false, error: "forbidden" };

  const stripe = getStripeClient();
  if (!stripe) return { ok: false, error: "stripe_not_configured" };

  const { data: salonRow } = await ctx.supabase
    .from("salons")
    .select("stripe_connect_account_id" as never)
    .eq("id", ctx.salon.id)
    .maybeSingle();
  const accountId =
    (salonRow as { stripe_connect_account_id?: string | null } | null)
      ?.stripe_connect_account_id ?? null;

  if (!accountId) {
    return {
      ok: true,
      status: { accountId: null, chargesEnabled: false, detailsSubmitted: false },
    };
  }

  try {
    const account = await stripe.accounts.retrieve(accountId);
    const chargesEnabled = Boolean(account.charges_enabled);
    const detailsSubmitted = Boolean(account.details_submitted);
    await ctx.supabase
      .from("salons")
      .update({
        stripe_connect_charges_enabled: chargesEnabled,
        stripe_connect_details_submitted: detailsSubmitted,
      } as never)
      .eq("id", ctx.salon.id);
    return {
      ok: true,
      status: { accountId, chargesEnabled, detailsSubmitted },
    };
  } catch (e) {
    console.error("[refreshStripeConnectStatus]", e);
    return { ok: false, error: "server_error" };
  }
}
