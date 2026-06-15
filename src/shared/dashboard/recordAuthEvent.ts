import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Record a login / logout into `auth_events` (surfaced in the owner Activity log:
 * who, when, device user-agent, IP). Best-effort — NEVER throws, so it can't
 * break a login or logout. IP + user-agent are read from request headers when
 * not supplied (works in both server actions and route handlers).
 */
export async function recordAuthEvent(opts: {
  event: "login" | "logout";
  userId?: string | null;
  /** Login: resolve salon_id from this slug. */
  slug?: string | null;
  role?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  try {
    let ip = opts.ip ?? null;
    let ua = opts.userAgent ?? null;
    if (ip == null || ua == null) {
      try {
        const { headers } = await import("next/headers");
        const h = await headers();
        if (ip == null) {
          const xff = h.get("x-forwarded-for");
          ip = (xff ? xff.split(",")[0]?.trim() : "") || h.get("x-real-ip") || null;
        }
        if (ua == null) ua = h.get("user-agent");
      } catch {
        /* no header context */
      }
    }

    let userId = opts.userId ?? null;
    if (!userId) {
      try {
        const { createClient } = await import("@/shared/lib/supabase/server");
        const sb = await createClient();
        const { data } = await sb.auth.getUser();
        userId = data.user?.id ?? null;
      } catch {
        /* no session */
      }
    }

    const db = createServiceRoleClient();
    let salonId: string | null = null;
    let role = opts.role ?? null;
    if (opts.slug) {
      const { data } = await db
        .from("salons" as never)
        .select("id")
        .eq("slug", opts.slug)
        .maybeSingle();
      salonId = (data as { id?: string } | null)?.id ?? null;
    } else if (userId) {
      // Logout has no slug — attribute it to the user's salon (first membership).
      const { data } = await db
        .from("salon_members" as never)
        .select("salon_id, role")
        .eq("user_id", userId)
        .limit(1)
        .maybeSingle();
      const m = data as { salon_id?: string; role?: string } | null;
      salonId = m?.salon_id ?? null;
      role = role ?? m?.role ?? null;
    }

    await db.from("auth_events" as never).insert({
      user_id: userId,
      salon_id: salonId,
      event_type: opts.event,
      actor_role: role,
      ip,
      user_agent: ua ? ua.slice(0, 300) : null,
    } as never);
  } catch (e) {
    console.error("[recordAuthEvent]", e);
  }
}
