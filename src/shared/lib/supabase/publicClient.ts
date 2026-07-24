import {
  createClient as createSupabaseClient,
  type SupabaseClient,
} from "@supabase/supabase-js";

let publicClient: SupabaseClient | null = null;

/**
 * Stateless client for deliberately public booking reads and RPCs.
 *
 * Public booking must behave the same whether the browser also has a NailIQ
 * dashboard session or not. Reusing the cookie/local-storage client would make
 * PostgreSQL evaluate SECURITY INVOKER views as `authenticated`, which is
 * correctly tenant-scoped and therefore cannot browse another salon's public
 * catalog. This client always sends only the publishable anon credential and
 * never persists or refreshes a user session.
 */
export function createPublicClient(): SupabaseClient {
  if (publicClient) return publicClient;

  publicClient = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    },
  );

  return publicClient;
}
