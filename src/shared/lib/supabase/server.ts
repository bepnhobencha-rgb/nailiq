import { createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";
import { authCookieOptions } from "@/shared/lib/supabase/authCookieOptions";
import { resolveSupabaseServerUrl } from "@/shared/lib/supabase/serverUrl";

export async function createClient() {
  const cookieStore = await cookies();
  const requestHeaders = await headers();
  return createServerClient(
    resolveSupabaseServerUrl()!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: authCookieOptions(requestHeaders.get("x-forwarded-proto") === "https"),
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
