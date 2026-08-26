import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { resolveSupabaseServerUrl } from "@/shared/lib/supabase/serverUrl";

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    resolveSupabaseServerUrl()!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet, responseHeaders) {
          try {
            void responseHeaders;
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch (e) {
            console.error("[supabase/server] failed to persist auth cookies", e);
          }
        },
      },
    },
  );
}
