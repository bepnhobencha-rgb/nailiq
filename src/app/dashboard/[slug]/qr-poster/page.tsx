import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { QrPosterClient } from "./QrPosterClient";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `QR Poster · ${slug}`,
    description: "Printable QR code poster for your salon booking page.",
  };
}

export default async function QrPosterPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    redirect("/register");
  }

  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const bookingUrl = `${siteUrl.replace(/\/$/, "")}/${encodeURIComponent(slug)}`;
  const salonName = (ctx.salon.name ?? "").trim() || slug;

  return (
    <QrPosterClient
      salonName={salonName}
      bookingUrl={bookingUrl}
      slug={slug}
    />
  );
}
