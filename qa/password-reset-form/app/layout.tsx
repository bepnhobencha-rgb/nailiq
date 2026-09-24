import { cookies } from "next/headers";
import { UserLanguageProvider } from "@/shared/lib/UserLanguageContext";
import { FixtureLanguageControls } from "../FixtureLanguageControls";
import "@/app/globals.css";
export default async function Layout({ children }: { children: React.ReactNode }) {
  // Supply a saved initial language without importing account reads or any Auth client.
  const initialLanguage = (await cookies()).get("nailiq-user-lang")?.value === "vi" ? "vi" : "en";
  return <html lang={initialLanguage}><body><UserLanguageProvider initialLanguage={initialLanguage}><FixtureLanguageControls />{children}</UserLanguageProvider></body></html>;
}
