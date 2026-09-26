import { UserLanguageProvider } from "@/shared/lib/UserLanguageContext";
import "@/app/globals.css";
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><UserLanguageProvider>{children}</UserLanguageProvider></body></html>;
}
