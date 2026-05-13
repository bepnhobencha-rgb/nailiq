/**
 * Lightweight reader for auth-relevant platform flags used outside the
 * SuperAdmin panel. Does NOT require superadmin auth — it is called from
 * server-only code paths (page.tsx, server actions) before any user
 * session is available.
 *
 * Defaults flipped 2026-05-13: Twilio not approved, so SMS is unusable in
 * production. Email magic link + Google OAuth + email/password are the
 * primary methods now. The DB row can still flip `sms_enabled=true` if
 * SMS becomes available later.
 */

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type AuthPlatformFlags = {
  smsEnabled: boolean;
  emailEnabled: boolean;
};

const AUTH_FLAG_DEFAULTS: AuthPlatformFlags = {
  smsEnabled: false,
  emailEnabled: true,
};

export async function readAuthPlatformFlags(): Promise<AuthPlatformFlags> {
  try {
    const admin = createServiceRoleClient();
    const { data, error } = (await (admin as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          in: (
            col: string,
            vals: string[],
          ) => Promise<{
            data: Array<{ key: string; enabled: boolean | null }> | null;
            error: unknown;
          }>;
        };
      };
    })
      .from("platform_flags")
      .select("key, enabled")
      .in("key", ["sms_enabled", "email_enabled"])) as {
      data: Array<{ key: string; enabled: boolean | null }> | null;
      error: unknown;
    };

    if (error || !data) return AUTH_FLAG_DEFAULTS;

    const byKey = new Map<string, boolean>();
    for (const r of data) {
      byKey.set(r.key, r.enabled === true);
    }

    return {
      // Defaults match AUTH_FLAG_DEFAULTS — only flip when the DB row
      // explicitly says otherwise. SMS is OFF by default (Twilio not
      // approved); email is ON.
      smsEnabled: byKey.get("sms_enabled") ?? false,
      emailEnabled: byKey.has("email_enabled")
        ? (byKey.get("email_enabled") as boolean)
        : true,
    };
  } catch {
    return AUTH_FLAG_DEFAULTS;
  }
}
