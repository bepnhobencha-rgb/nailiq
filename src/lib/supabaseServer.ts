import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Supabase client dùng Service Role Key — chỉ gọi từ Server Components,
 * Route Handlers hoặc Server Actions. Không import module này trong code client.
 */
export function createSupabaseServerClient() {
  return createServiceRoleClient();
}
