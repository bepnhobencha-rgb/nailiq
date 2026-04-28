import { createClient } from "@supabase/supabase-js";

/**
 * Privileged Supabase client for server-only mutations that bypass RLS
 * (registration OTP rows, salon seeding, etc.). Requires `SUPABASE_SERVICE_ROLE_KEY`.
 */
export function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
