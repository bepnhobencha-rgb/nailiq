import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import { getSiteUrl } from "@/shared/seo/site";
import "./globals.css";

// Inter (not Geist) for body sans because Geist on Google Fonts does not
// ship a `vietnamese` subset; Vietnamese diacritics fell back to system fonts.
const appSans = Inter({
  variable: "--font-app-sans",
  subsets: ["latin", "vietnamese"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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
  openGraph: {
    type: "website",
    locale: "en_US",
    url: siteUrl,
    siteName: "NailIQ",
    title: "NailIQ — AI Booking System for Nail Salons",
    description: defaultDescription,
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
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${appSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-dvh min-w-0 flex flex-col overflow-x-hidden">
        {children}
      </body>
    </html>
  );
}
