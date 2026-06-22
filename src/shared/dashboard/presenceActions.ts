"use server";

import { createClient } from "@/shared/lib/supabase/server";
import { headers } from "next/headers";

export type PresenceRow = {
  userId: string;
  salonId: string;
  email: string | null;
  memberName: string | null;
  role: string;
  ipAddress: string | null;
  userAgent: string | null;
  deviceType: string | null;
  browser: string | null;
  currentPath: string | null;
  batteryLevel: number | null;
  lastSeenAt: string;
};

/** Parse user-agent into a short device+browser description. */
function parseUserAgent(ua: string | null): { device: string; browser: string } {
  if (!ua) return { device: "desktop", browser: "Unknown" };
  const isMobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  const isTablet = /iPad|Tablet/i.test(ua);
  const device = isTablet ? "tablet" : isMobile ? "mobile" : "desktop";
  const browser = /Edg\//i.test(ua)
    ? "Edge"
    : /Chrome/i.test(ua)
      ? "Chrome"
      : /Firefox/i.test(ua)
        ? "Firefox"
        : /Safari/i.test(ua)
          ? "Safari"
          : "Browser";
  return { device, browser };
}

/**
 * Upsert the caller's presence row. Called by the client heartbeat every 30s.
 * Reads the real IP from the `x-forwarded-for` header (set by Vercel/Nginx).
 */
export async function upsertPresence(params: {
  salonId: string;
  currentPath: string;
  batteryLevel?: number | null;
  userAgent?: string;
}): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false };

  const hdrs = await headers();
  const forwarded = hdrs.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",")[0]?.trim() ?? null : null;
  const ua = params.userAgent ?? hdrs.get("user-agent") ?? null;
  const { device, browser } = parseUserAgent(ua);

  const { error } = await (supabase
    .from("user_presence" as never)
    .upsert(
      {
        user_id: user.id,
        salon_id: params.salonId,
        ip_address: ip,
        user_agent: ua,
        device_type: device,
        browser,
        current_path: params.currentPath,
        battery_level: params.batteryLevel ?? null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    ) as unknown as { error: unknown });

  if (error) {
    console.error("[presenceActions/upsertPresence]", error);
    return { ok: false };
  }
  return { ok: true };
}

/**
 * Load active sessions for a salon (owner/admin only).
 * "Active" = last_seen_at within the past 5 minutes.
 */
export async function loadSalonSessions(slug: string): Promise<{
  ok: boolean;
  sessions?: PresenceRow[];
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };

  // Verify caller is owner/admin of this salon.
  const { data: salon } = await supabase
    .from("salons")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (!salon?.id) return { ok: false, error: "not_found" };

  const { data: membership } = await supabase
    .from("salon_members")
    .select("role")
    .eq("salon_id", salon.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership || !["owner", "admin", "manager"].includes(membership.role)) {
    return { ok: false, error: "unauthorized" };
  }

  // Fetch presence rows joined with salon_members for name + role.
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: rows, error } = await (supabase
    .from("user_presence" as never)
    .select(`
      user_id, salon_id, ip_address, user_agent, device_type, browser,
      current_path, battery_level, last_seen_at
    `)
    .eq("salon_id" as never, salon.id)
    .gte("last_seen_at" as never, cutoff)
    .order("last_seen_at" as never, { ascending: false }) as unknown as {
    data: Array<{
      user_id: string;
      salon_id: string;
      ip_address: string | null;
      user_agent: string | null;
      device_type: string | null;
      browser: string | null;
      current_path: string | null;
      battery_level: number | null;
      last_seen_at: string;
    }> | null;
    error: unknown;
  });

  if (error) {
    console.error("[presenceActions/loadSalonSessions]", error);
    return { ok: false, error: "server_error" };
  }

  if (!rows?.length) return { ok: true, sessions: [] };

  // Batch-load salon_members for name + role + email.
  const userIds = rows.map((r) => r.user_id);
  const { data: members } = await supabase
    .from("salon_members")
    .select("user_id, role, name, email")
    .eq("salon_id", salon.id)
    .in("user_id", userIds);

  const memberMap = new Map(
    (members ?? []).map((m) => [
      m.user_id as string,
      { role: String(m.role ?? ""), name: m.name as string | null, email: m.email as string | null },
    ]),
  );

  const sessions: PresenceRow[] = rows.map((r) => {
    const m = memberMap.get(r.user_id);
    return {
      userId: r.user_id,
      salonId: r.salon_id,
      email: m?.email ?? null,
      memberName: m?.name ?? null,
      role: m?.role ?? "staff",
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
      deviceType: r.device_type,
      browser: r.browser,
      currentPath: r.current_path,
      batteryLevel: r.battery_level,
      lastSeenAt: r.last_seen_at,
    };
  });

  return { ok: true, sessions };
}
