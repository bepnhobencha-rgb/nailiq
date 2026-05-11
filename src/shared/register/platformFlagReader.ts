/**
 * Lightweight reader for auth-relevant platform flags used outside the
 * SuperAdmin panel. Does NOT require superadmin auth — it is called from
 * server-only code paths (page.tsx, server actions) before any user
 * session is available.
 *
 * Defaults are conservative: smsEnabled=true preserves the existing SMS
 * flow when the table is missing or the row hasn't been seeded yet.
 */

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type AuthPlatformFlags = {
  smsEnabled: boolean;
  emailEnabled: boolean;
};

const AUTH_FLAG_DEFAULTS: AuthPlatformFlags = {
  smsEnabled: true,
  emailEnabled: false,
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
      // Default smsEnabled=true so existing prod installs without a row
      // continue sending SMS uninterrupted.
      smsEnabled: byKey.has("sms_enabled")
        ? (byKey.get("sms_enabled") as boolean)
        : true,
      emailEnabled: byKey.get("email_enabled") ?? false,
    };
  } catch {
    return AUTH_FLAG_DEFAULTS;
  }
}
