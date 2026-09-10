"use client";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
// Test-only controls exercise the existing shared provider without adding UI to Production.
export function FixtureLanguageControls() {
  const { setLanguage } = useUserLanguage();
  return <nav aria-label="Fixture language controls"><button data-testid="fixture-lang-en" onClick={() => setLanguage("en")}>EN</button><button data-testid="fixture-lang-vi" onClick={() => setLanguage("vi")}>VI</button></nav>;
}
