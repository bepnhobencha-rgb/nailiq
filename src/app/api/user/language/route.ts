import { NextResponse } from "next/server";
import { createClient } from "@/shared/lib/supabase/server";
import { USER_LANGUAGES, type UserLanguage } from "@/shared/i18n/user/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/user/language  { language: "en" | "vi" }
 *
 * Saves the language on the logged-in user's account (auth user_metadata) so
 * the choice follows them across devices. Anonymous callers get 401 (the client
 * fires this best-effort; the cookie/localStorage still carry the choice
 * per-device). Only the owner-surface resolver reads this — the customer
 * booking page keeps its own per-surface language.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { language?: string };
  const language = body.language;
  if (!language || !USER_LANGUAGES.includes(language as UserLanguage)) {
    return NextResponse.json({ ok: false, error: "invalid_language" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const { error } = await supabase.auth.updateUser({
    data: { user_language: language },
  });
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
