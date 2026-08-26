type SupabaseUrlEnvironment = Record<string, string | undefined> & {
  SUPABASE_INTERNAL_URL?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
};

/**
 * Prefer a private/local Supabase origin for server-side work when one is
 * configured. Browser code must continue to use NEXT_PUBLIC_SUPABASE_URL.
 */
export function resolveSupabaseServerUrl(
  env: SupabaseUrlEnvironment = process.env,
): string | undefined {
  return (
    env.SUPABASE_INTERNAL_URL?.trim() ||
    env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    undefined
  );
}
