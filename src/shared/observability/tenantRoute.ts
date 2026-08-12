import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Return only route segments that can legitimately identify a salon. */
export function salonSlugCandidates(route: string | null): string[] {
  if (!route) return [];
  const pathname = route.split(/[?#]/, 1)[0] ?? "";
  const segments = pathname.split("/").filter(Boolean);
  const candidates = segments[0] === "dashboard" || segments[0] === "embed"
    ? [segments[1]]
    : [segments[0]];
  return candidates.filter((value): value is string =>
    typeof value === "string" && value.length <= 100 && SLUG_RE.test(value),
  );
}

/**
 * Resolve public client-error routes server-side. Never trust a client-supplied
 * salon UUID: an anonymous reporter could otherwise spoof another tenant.
 */
export async function resolveSalonIdFromRoute(route: string | null): Promise<string | null> {
  const candidates = salonSlugCandidates(route);
  if (!candidates.length) return null;
  const db = createServiceRoleClient();
  const { data } = await db
    .from("salons")
    .select("id")
    .in("slug", candidates)
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}
