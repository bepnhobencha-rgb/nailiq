"use client";

import { useRouter } from "next/navigation";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { UserLanguageToggle } from "@/components/user/UserLanguageToggle";

/**
 * The one EN/VI switch to drop anywhere in the dashboard. Switching here
 * flips EVERY surface in lockstep:
 *   - client UI re-renders instantly (shared `useUserLanguage` state),
 *   - the cookie is persisted, then `router.refresh()` re-renders the
 *     server components too — so server-rendered copy and AI output
 *     (e.g. the Owner Pulse briefing, Coco) come back in the new language.
 *
 * English is the product default (see `resolveUserLanguage`); this is the
 * explicit opt-in that then sticks for the user across pages and tabs.
 */
export function GlobalLanguageToggle({
  className,
  variant = "compact",
}: {
  className?: string;
  variant?: "compact" | "menu";
}) {
  const router = useRouter();
  const { language, setLanguage } = useUserLanguage();
  return (
    <UserLanguageToggle
      language={language}
      className={className}
      variant={variant}
      onLanguageChange={(next) => {
        if (next === language) return;
        setLanguage(next);
        router.refresh();
      }}
    />
  );
}
