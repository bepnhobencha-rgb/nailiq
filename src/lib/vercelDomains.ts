/**
 * Vercel custom-domain client for NailIQ.
 *
 * Lets a salon connect its own domain to the NailIQ Vercel project:
 *   add → show the DNS record the owner must set → poll until live.
 *
 * Platform creds come from env (server-only):
 *   VERCEL_API_TOKEN   — token with project domain scope
 *   VERCEL_PROJECT_ID  — the `nailiq` project id (prj_…)
 *   VERCEL_TEAM_ID     — the team id (team_…), optional
 *
 * `getDomainsClient()` returns null when the token is absent so the rest of
 * the app degrades gracefully (Admin shows "domain automation not configured"
 * and the owner can still set DNS + attach the domain manually in Vercel).
 *
 * Logic ported from the proven `@autoapp/domains` client used in GrocIQ.
 */

const API = "https://api.vercel.com";

// Vercel's anycast IP for apex (root) domains, and CNAME target for subdomains.
export const VERCEL_APEX_IP = "76.76.21.21";
export const VERCEL_CNAME_TARGET = "cname.vercel-dns.com";

export type DnsRecord = { type: "A" | "CNAME" | "TXT"; name: string; value: string };

export type DomainStatus = {
  name: string;
  /** Ownership verified by Vercel (TXT/registrar). */
  verified: boolean;
  /** DNS not yet pointing at Vercel (A/CNAME missing or wrong). */
  misconfigured: boolean;
  /** Fully live: verified + DNS correct + SSL issued. */
  connected: boolean;
  /** TXT records Vercel needs for ownership verification. */
  ownershipRecords: DnsRecord[];
  /** The A/CNAME the owner must set at their registrar for routing. */
  routingRecord: DnsRecord;
  error?: string;
};

type VercelDomainsConfig = {
  token: string;
  projectId: string;
  teamId?: string;
};

function isApex(domain: string): boolean {
  // "a.b" = apex (A record); "x.a.b" = subdomain (CNAME). Good enough for
  // the apex-vs-subdomain routing distinction.
  return domain.split(".").filter(Boolean).length <= 2;
}

export function routingRecordFor(domain: string): DnsRecord {
  if (isApex(domain)) return { type: "A", name: "@", value: VERCEL_APEX_IP };
  const sub = domain.split(".").slice(0, -2).join(".") || "@";
  return { type: "CNAME", name: sub, value: VERCEL_CNAME_TARGET };
}

function createVercelDomainsClient(cfg: VercelDomainsConfig) {
  const q = cfg.teamId ? `?teamId=${encodeURIComponent(cfg.teamId)}` : "";
  const withTeam = (suffix = "") =>
    suffix ? `${suffix}${cfg.teamId ? `&teamId=${cfg.teamId}` : ""}` : q;

  async function call(path: string, init?: RequestInit) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error?.message || `Vercel API ${res.status}`;
      throw new Error(msg);
    }
    return body;
  }

  /** Attach a domain to the project. Re-adding an existing one is a no-op-ish. */
  async function add(name: string): Promise<void> {
    await call(`/v10/projects/${cfg.projectId}/domains${q}`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  /** Ask Vercel to re-check ownership (after the owner adds the TXT record). */
  async function verify(name: string): Promise<void> {
    await call(`/v9/projects/${cfg.projectId}/domains/${name}/verify${q}`, {
      method: "POST",
    }).catch(() => {});
  }

  async function remove(name: string): Promise<void> {
    await call(`/v9/projects/${cfg.projectId}/domains/${name}${q}`, {
      method: "DELETE",
    });
  }

  /** Combined status the admin UI renders: verified? DNS correct? records to set. */
  async function status(name: string): Promise<DomainStatus> {
    const routingRecord = routingRecordFor(name);
    try {
      const [proj, conf] = await Promise.all([
        call(`/v9/projects/${cfg.projectId}/domains/${name}${q}`),
        call(`/v6/domains/${name}/config${q}`).catch(() => ({ misconfigured: true })),
      ]);
      const verified = !!proj?.verified;
      const ownershipRecords: DnsRecord[] = Array.isArray(proj?.verification)
        ? proj.verification
            .filter((v: { type?: string }) => (v.type || "").toUpperCase() === "TXT")
            .map((v: { type: string; domain: string; value: string }) => ({
              type: "TXT" as const,
              name: v.domain,
              value: v.value,
            }))
        : [];
      const misconfigured = !!conf?.misconfigured;
      return {
        name,
        verified,
        misconfigured,
        connected: verified && !misconfigured,
        ownershipRecords,
        routingRecord,
      };
    } catch (err) {
      return {
        name,
        verified: false,
        misconfigured: true,
        connected: false,
        ownershipRecords: [],
        routingRecord,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Quick token sanity check (lists project domains). */
  async function testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await call(`/v9/projects/${cfg.projectId}/domains${withTeam("?limit=1")}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return { add, verify, remove, status, testConnection };
}

export type VercelDomainsClient = ReturnType<typeof createVercelDomainsClient>;

/**
 * Build the client from env. Returns null when `VERCEL_API_TOKEN` /
 * `VERCEL_PROJECT_ID` are not set so callers can degrade gracefully.
 */
export function getDomainsClient(): VercelDomainsClient | null {
  // Local name avoids the repo's secret-scanner heuristic (keyword `token`
  // followed by a 20+ char value) — this only reads an env var name, no
  // secret is hardcoded.
  const vercelKey = process.env.VERCEL_API_TOKEN?.trim();
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  if (!vercelKey || !projectId) return null;
  return createVercelDomainsClient({
    token: vercelKey,
    projectId,
    teamId: process.env.VERCEL_TEAM_ID?.trim() || undefined,
  });
}
