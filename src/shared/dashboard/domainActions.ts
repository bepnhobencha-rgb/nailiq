"use server";

import {
  getDomainsClient,
  routingRecordFor,
  type DnsRecord,
  type DomainStatus,
} from "@/lib/vercelDomains";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

// Lowercase hostname: 1+ labels + TLD. Blocks protocols, paths, spaces, ports.
const DOMAIN_RE =
  /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export type SalonDomainInfo = {
  /** The salon's connected domain, or null when none is set. */
  domain: string | null;
  /** The A/CNAME the owner must set at their registrar (shown even when
   *  Vercel automation is off so they can still wire DNS manually). */
  routingRecord: DnsRecord | null;
  /** Live Vercel status (verified / DNS correct / SSL). Null when automation
   *  is not configured or no domain is set. */
  status: DomainStatus | null;
  /** Whether VERCEL_API_TOKEN is configured (enables auto add/verify). */
  automationConfigured: boolean;
};

export type ConnectDomainResult =
  | { ok: true; info: SalonDomainInfo }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "forbidden"
        | "invalid_domain"
        | "domain_taken"
        | "vercel_failed"
        | "server_error";
      message?: string;
    };

function normalizeDomain(raw: string): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
}

type DashboardWriteCtx = NonNullable<
  Awaited<ReturnType<typeof import("@/shared/dashboard/setupActions").getDashboardWriteClient>>
>;

type OwnerCtxResult =
  | { ok: true; ctx: DashboardWriteCtx }
  | { ok: false; error: "unauthorized" | "forbidden" };

async function ownerCtx(slug: string): Promise<OwnerCtxResult> {
  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };
  return { ok: true, ctx };
}

/** Read the salon's current domain + (when configured) its live Vercel status. */
export async function getSalonDomain(slug: string): Promise<SalonDomainInfo> {
  const r = await ownerCtx(slug);
  if (!r.ok) {
    return { domain: null, routingRecord: null, status: null, automationConfigured: false };
  }
  const { ctx } = r;
  const client = getDomainsClient();

  const { data } = await ctx.supabase
    .from("salon_custom_domains" as never)
    .select("domain")
    .eq("salon_id", ctx.salon.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const domain =
    (data as { domain?: string } | null)?.domain?.trim() || null;

  if (!domain) {
    return { domain: null, routingRecord: null, status: null, automationConfigured: !!client };
  }

  const status = client ? await client.status(domain) : null;
  return {
    domain,
    routingRecord: routingRecordFor(domain),
    status,
    automationConfigured: !!client,
  };
}

/** Connect (or replace) the salon's custom domain. */
export async function connectSalonDomain(
  slug: string,
  rawDomain: string,
): Promise<ConnectDomainResult> {
  const r = await ownerCtx(slug);
  if (!r.ok) return { ok: false, error: r.error };
  const { ctx } = r;

  const domain = normalizeDomain(rawDomain);
  if (!domain || domain.length > 253 || !DOMAIN_RE.test(domain)) {
    return { ok: false, error: "invalid_domain" };
  }

  // Reject if another salon already owns this domain.
  const { data: existing } = await ctx.supabase
    .from("salon_custom_domains" as never)
    .select("salon_id")
    .eq("domain", domain)
    .maybeSingle();
  const owner = (existing as { salon_id?: string } | null)?.salon_id;
  if (owner && owner !== ctx.salon.id) {
    return { ok: false, error: "domain_taken" };
  }

  // Attach to the Vercel project first (when automation is configured) so a
  // Vercel rejection (e.g. domain already on another project) surfaces before
  // we persist. When no token, skip — routing still works from the DB row.
  const client = getDomainsClient();
  if (client) {
    try {
      await client.add(domain);
    } catch (e) {
      return {
        ok: false,
        error: "vercel_failed",
        message: e instanceof Error ? e.message : undefined,
      };
    }
  }

  // One domain per salon for now: clear any previous rows, then insert.
  await ctx.supabase
    .from("salon_custom_domains" as never)
    .delete()
    .eq("salon_id", ctx.salon.id);

  const { error: insErr } = await ctx.supabase
    .from("salon_custom_domains" as never)
    .insert({ salon_id: ctx.salon.id, domain } as never);

  if (insErr) {
    console.error("[connectSalonDomain]", insErr);
    return { ok: false, error: "server_error", message: insErr.message };
  }

  const status = client ? await client.status(domain) : null;
  return {
    ok: true,
    info: {
      domain,
      routingRecord: routingRecordFor(domain),
      status,
      automationConfigured: !!client,
    },
  };
}

/** Re-check ownership/DNS with Vercel and return fresh status. */
export async function refreshSalonDomain(slug: string): Promise<SalonDomainInfo> {
  const r = await ownerCtx(slug);
  if (!r.ok) {
    return { domain: null, routingRecord: null, status: null, automationConfigured: false };
  }
  const { ctx } = r;
  const info = await getSalonDomain(slug);
  const client = getDomainsClient();
  if (client && info.domain) {
    await client.verify(info.domain);
    const status = await client.status(info.domain);
    // Mirror verified flag onto the row for display/routing audits.
    await ctx.supabase
      .from("salon_custom_domains" as never)
      .update({ verified: status.connected, updated_at: new Date().toISOString() } as never)
      .eq("salon_id", ctx.salon.id)
      .eq("domain", info.domain);
    return { ...info, status };
  }
  return info;
}

/** Disconnect: remove from Vercel (when configured) + delete the row. */
export async function disconnectSalonDomain(
  slug: string,
): Promise<{ ok: boolean; error?: string }> {
  const r = await ownerCtx(slug);
  if (!r.ok) return { ok: false, error: r.error };
  const { ctx } = r;

  const info = await getSalonDomain(slug);
  const client = getDomainsClient();
  if (client && info.domain) {
    await client.remove(info.domain).catch(() => {});
  }
  const { error } = await ctx.supabase
    .from("salon_custom_domains" as never)
    .delete()
    .eq("salon_id", ctx.salon.id);
  if (error) {
    console.error("[disconnectSalonDomain]", error);
    return { ok: false, error: "server_error" };
  }
  return { ok: true };
}
