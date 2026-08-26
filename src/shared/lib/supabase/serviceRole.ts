import { createClient } from "@supabase/supabase-js";
import { resolveSupabaseServerUrl } from "@/shared/lib/supabase/serverUrl";

/**
 * Privileged Supabase client for server-only mutations that bypass RLS
 * (registration OTP rows, salon seeding, etc.). Requires `SUPABASE_SERVICE_ROLE_KEY`.
 */
export function createServiceRoleClient() {
  const url = resolveSupabaseServerUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "\n[nailiq] ⚠️  createServiceRoleClient: SUPABASE_SERVICE_ROLE_KEY is not set.\n" +
          "  Service-role operations (Party Link creation, OTP seeding, etc.) will fail silently.\n" +
          "  → Copy SUPABASE_SERVICE_ROLE_KEY from Supabase Dashboard → Project → Settings → API\n" +
          "    into your .env.local to enable full local testing.\n" +
          "  → See docs/testing.md §\"Party Link local testing\" for details.\n",
      );
    }
    throw new Error(
      "Missing SUPABASE_INTERNAL_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
