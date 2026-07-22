"use client";

import { useMemo } from "react";
import { SocialAuthButtons } from "@/components/auth/SocialAuthButtons";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

/**
 * /register entry — unified sign-in/sign-up surface.
 *
 * Phone OTP was retired 2026-05-13 (Twilio not approved). The new flow is
 * Google OAuth + email magic link + email/password, all delegated to
 * `SocialAuthButtons` with `layout="open"`. Post-auth routing for OAuth
 * and magic link goes through `/auth/callback/route.ts`; password sign-in
 * / sign-up runs `resolvePostAuthRedirect()` and navigates client-side.
 *
 * Anyone with a session lands on `/register/setup` (no salon) or their
 * dashboard (existing salon) — the redirect happens before this client
 * component renders, in `register/page.tsx`.
 */
export function RegisterPageClient() {
  const { language } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language).auth, [language]);

  return (
    <RegisterStepShell
      title={t.signInOrSignUpTitle}
      subtext={t.signInOrSignUpSubtext}
      helperHint={t.registerMicrotrust}
      showBrandPanel
      step={{ current: 1, total: 3 }}
    >
      <SocialAuthButtons mode="register" layout="open" />
    </RegisterStepShell>
  );
}
