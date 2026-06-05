/**
 * Custom-domain → tenant resolution for the request proxy.
 *
 * A salon can serve its public booking page on its own domain (e.g.
 * hiliteheadspa.com). The proxy detects a non-platform host, resolves it to
 * the salon's slug via the `public_resolve_domain` RPC, and rewrites `/` to
 * `/<slug>`. Platform hosts (nailiq.ca, *.vercel.app, localhost) bypass this
 * entirely so normal traffic is untouched and pays no extra cost.
 */
import { createServerClient } from "@supabase/ssr";
import { getSiteUrl } from "@/shared/seo/site";

/** Hosts that are NEVER custom tenant domains. */
function platformRootHost(): string {
  try {
    return new URL(getSiteUrl()).hostname; // e.g. www.nailiq.ca
  } catch {
    return "www.nailiq.ca";
  }
}

/**
 * True when `host` is the platform itself (so we skip custom-domain logic).
 * Strips the port and lower-cases first.
 */
export function isPlatformHost(host: string): boolean {
  const h = (host.split(":")[0] || "").toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1") {
    return true;
  }
  if (h.endsWith(".vercel.app")) return true;
  if (h === "nailiq.ca" || h === "www.nailiq.ca") return true;
  const root = platformRootHost();
  // Match the canonical host plus its apex/www variants.
  if (h === root) return true;
  if (h === `www.${root}` || `www.${h}` === root) return true;
  if (root.startsWith("www.") && h === root.slice(4)) return true;
  return false;
}

// Per-instance cache so a busy custom domain doesn't hit the RPC every request.
// Date.now() is fine here — this is app runtime, not a workflow script.
const CACHE = new Map<string, { slug: string | null; exp: number }>();
const TTL_MS = 60_000;

/**
 * Resolve a hostname to a salon slug, or null. Cached for 60s per instance.
 * Uses an anon client + SECURITY DEFINER RPC, so it needs no service role and
 * never exposes the domains table.
 */
export async function resolveCustomDomainSlug(host: string): Promise<string | null> {
  const h = (host.split(":")[0] || "").toLowerCase();
  if (!h) return null;

  const now = Date.now();
  const hit = CACHE.get(h);
  if (hit && hit.exp > now) return hit.slug;

  let slug: string | null = null;
  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: { getAll: () => [], setAll: () => {} } },
    );
    const { data } = await supabase.rpc(
      "public_resolve_domain" as never,
      { p_host: h } as never,
    );
    slug = typeof data === "string" && data.trim() ? data.trim() : null;
  } catch {
    slug = null;
  }

  CACHE.set(h, { slug, exp: now + TTL_MS });
  return slug;
}
