import { createClient } from "@/shared/lib/supabase/client";

/**
 * Supabase browser client — dùng NEXT_PUBLIC_SUPABASE_URL và NEXT_PUBLIC_SUPABASE_ANON_KEY
 * (đồng bộ với @/shared/lib/supabase/client). Chỉ gọi từ Client Components / browser.
 */
export function createSupabaseClient() {
  return createClient();
}
