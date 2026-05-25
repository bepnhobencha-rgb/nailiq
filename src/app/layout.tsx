import type { Metadata } from "next";
import { Be_Vietnam_Pro, JetBrains_Mono } from "next/font/google";
import { getSiteUrl } from "@/shared/seo/site";
import { UserLanguageProvider } from "@/shared/lib/UserLanguageContext";
import { resolveUserLanguage } from "@/shared/i18n/user/resolveUserLanguage";
import "./globals.css";

// Be Vietnam Pro: hand-tuned VN diacritics for body sans.
const appSans = Be_Vietnam_Pro({
  variable: "--font-app-sans",
  subsets: ["latin", "vietnamese"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

// JetBrains Mono (not Geist_Mono) for `font-mono` because Geist's mono
// has no `vietnamese` subset — receptionist `font-mono` labels with VN
// service names / status pills (e.g. "CHỜ", "ĐANG PHỤC VỤ") were falling
// back to system mono and rendering with detached-looking diacritics.
const appMono = JetBrains_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin", "vietnamese"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const siteUrl = getSiteUrl();

const defaultDescription =
  "AI-powered booking, automation, and growth system for nail salons. Get more bookings, reduce missed calls, and automate your salon.";

const keywords = [
  "AI booking system",
  "nail salon booking software",
  "salon automation",
  "nail salon website",
  "AI receptionist for salons",
  "nail salon scheduling",
];

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "NailIQ — AI Booking System for Nail Salons",
    template: "%s | NailIQ",
  },
  description: defaultDescription,
  keywords,
  alternates: {
    canonical: "/",
    languages: {
      "x-default": "/",
      en: "/",
      vi: "/",
    },
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: siteUrl,
    siteName: "NailIQ",
    title: "NailIQ — AI Booking System for Nail Salons",
    description: defaultDescription,
    // og:image is supplied via src/app/opengraph-image.tsx (file convention) —
    // Next injects it into both og:image and twitter:image automatically.
  },
  twitter: {
    card: "summary_large_image",
    title: "NailIQ — AI Booking System for Nail Salons",
    description: defaultDescription,
  },
  robots: {
    index: true,
    follow: true,
  },
  verification: {
    // Env var wins (lets preview/staging use a different token); falls back to
    // the production Search Console token so the meta tag ships even if the
    // Vercel env var is unset. This value is public (it appears in page HTML).
    google:
      process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION ??
      "7_QuJd5ZC1ZjvHCU5Y2YFSEmZWiFB6cSds4QIoktcig",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Read cookie + Accept-Language on the server so the first HTML paint
  // is already in the visitor's preferred language. EN is the fallback;
  // we only flip to VI when the visitor's primary locale starts with
  // `vi`. Reading headers() opts the root layout into dynamic rendering,
  // which is acceptable here — every downstream page already depends on
  // auth/cookies via `proxy.ts`.
  const initialLanguage = await resolveUserLanguage();

  return (
    <html
      lang={initialLanguage}
      className={`${appSans.variable} ${appMono.variable} h-full antialiased`}
    >
      <body className="min-h-dvh min-w-0 flex flex-col overflow-x-hidden">
        <UserLanguageProvider initialLanguage={initialLanguage}>
          {children}
        </UserLanguageProvider>
      </body>
    </html>
  );
}
